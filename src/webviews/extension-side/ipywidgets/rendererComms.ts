// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type * as nbformat from '@jupyterlab/nbformat';
import type { IKernelConnection } from '@jupyterlab/services/lib/kernel/kernel';
import type { IIOPubMessage, IOPubMessageType } from '@jupyterlab/services/lib/kernel/messages';
import { injectable, inject } from 'inversify';
import { Disposable, EventEmitter, NotebookController, NotebookDocument, NotebookEditor, NotebookRendererMessaging, notebooks, Uri } from 'vscode';
import { IKernel, IKernelProvider } from '../../../kernels/types';
import { IControllerRegistration } from '../../../notebooks/controllers/types';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { WIDGET_MIMETYPE, Identifiers } from '../../../platform/common/constants';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { IDisposable } from '../../../platform/common/types';
import { noop } from '../../../platform/common/utils/misc';
import { logger } from '../../../platform/logging';
import { IPyWidgetMessageDispatcherFactory } from '../../../notebooks/controllers/ipywidgets/message/ipyWidgetMessageDispatcherFactory';
import { CommonMessageCoordinator } from '../../../notebooks/controllers/ipywidgets/message/commonMessageCoordinator';
import { IServiceContainer } from '../../../platform/ioc/types';
import { IWebviewCommunication } from '../../../platform/webviews/types';
import { isJupyterNotebook } from '../../../platform/common/utils';

type WidgetData = {
    model_id: string;
};

type QueryWidgetStateCommand = { command: 'query-widget-state'; model_id: string };
type RendererLoadedCommand = { command: 'ipywidget-renderer-loaded' };

@injectable()
export class IPyWidgetRendererComms implements IExtensionSyncActivationService {
    private readonly disposables: IDisposable[] = [];
    constructor(
        @inject(IKernelProvider) private readonly kernelProvider: IKernelProvider,
        @inject(IControllerRegistration) private readonly controllers: IControllerRegistration,
        @inject(IPyWidgetMessageDispatcherFactory)
        private readonly ipywidgetMessageDispatcher: IPyWidgetMessageDispatcherFactory,
        @inject(IServiceContainer) private readonly serviceContainer: IServiceContainer
    ) {}
    private readonly widgetOutputsPerNotebook = new WeakMap<NotebookDocument, Set<string>>();
    private readonly rendererChannelCoordinators = new WeakMap<NotebookDocument, CommonMessageCoordinator>();
    private readonly rendererChannelEmitters = new WeakMap<NotebookEditor, EventEmitter<unknown>>();
    public dispose() {
        dispose(this.disposables);
    }
    activate() {
        const comms = notebooks.createRendererMessaging('jupyter-ipywidget-renderer');
        comms.onDidReceiveMessage(this.onDidReceiveMessage.bind(this, comms), this, this.disposables);
        this.kernelProvider.onDidStartKernel(this.onDidStartKernel, this, this.disposables);
    }
    private onDidStartKernel(e: IKernel) {
        this.hookupKernel(e);
        e.onStarted(() => this.hookupKernel(e), this, this.disposables);
        e.onRestarted(() => this.hookupKernel(e), this, this.disposables);
    }
    private hookupKernel(kernel: IKernel) {
        this.widgetOutputsPerNotebook.delete(kernel.notebook);
        const previousKernelConnection = kernel.session?.kernel;
        const iopubMessage = kernel.session?.kernel?.iopubMessage;
        if (!iopubMessage) {
            return;
        }

        // If we have an output widget nested within another output widget.
        // Then the output output widget will be displayed by us.
        // However nested outputs (any) widgets will be displayed by widget manager.
        // And in this case, its possible the display_data message is sent to the webview,
        // Sooner than we get the messages from the IKernel above.
        // Hence we need to hook into the lower level kernel socket messages to see if that happens.
        // Else what happens is the display_data is sent to the webview, but the widget manager doesn't know about it.
        // Thats because we have not tracked this model and we don't know about it.
        const ipyWidgetMessageDispatcher = this.ipywidgetMessageDispatcher.create(kernel.notebook);
        this.disposables.push(
            ipyWidgetMessageDispatcher.onDisplayMessage((msg) => {
                this.trackModelId(kernel.notebook, msg);
            })
        );

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const jupyterLab = require('@jupyterlab/services') as typeof import('@jupyterlab/services');
        const handler = (kernelConnection: IKernelConnection, msg: IIOPubMessage<IOPubMessageType>) => {
            if (kernelConnection !== previousKernelConnection) {
                // Must be some old message from a previous kernel (before a restart or the like.)
                return;
            }

            if (
                jupyterLab.KernelMessage.isDisplayDataMsg(msg) ||
                jupyterLab.KernelMessage.isUpdateDisplayDataMsg(msg) ||
                jupyterLab.KernelMessage.isExecuteReplyMsg(msg) ||
                jupyterLab.KernelMessage.isExecuteResultMsg(msg)
            ) {
                this.trackModelId(kernel.notebook, msg);
            } else if (
                jupyterLab.KernelMessage.isCommOpenMsg(msg) &&
                // Track widget model ids as soon as the comm opens to avoid races with renderer queries.
                msg.content?.target_name === Identifiers.DefaultCommTarget &&
                typeof msg.content?.comm_id === 'string'
            ) {
                this.addModelId(kernel.notebook, msg.content.comm_id);
            }
        };
        iopubMessage.connect(handler);
        this.disposables.push(new Disposable(() => iopubMessage.disconnect(handler)));
    }
    private addModelId(notebook: NotebookDocument, modelId: string) {
        const set = this.widgetOutputsPerNotebook.get(notebook) || new Set<string>();
        set.add(modelId);
        this.widgetOutputsPerNotebook.set(notebook, set);
    }
    private trackModelId(
        notebook: NotebookDocument,
        msg: {
            content: {
                data: nbformat.IMimeBundle;
            };
        }
    ) {
        const output = msg.content;
        if (output.data && typeof output.data === 'object' && WIDGET_MIMETYPE in output.data) {
            const widgetData = output.data[WIDGET_MIMETYPE] as WidgetData;
            if (widgetData && 'model_id' in widgetData) {
                this.addModelId(notebook, widgetData.model_id);
            }
        }
    }
    private onDidReceiveMessage(
        comms: NotebookRendererMessaging,
        { editor, message }: { editor: NotebookEditor; message: QueryWidgetStateCommand | RendererLoadedCommand }
    ) {
        if (message && typeof message === 'object' && message.command === 'query-widget-state') {
            this.queryWidgetState(comms, editor, message);
        }
        if (message && typeof message === 'object' && message.command === 'ipywidget-renderer-loaded') {
            this.sendWidgetVersionAndState(comms, editor);
        }
        // Kernel messages (shape `{ type }`) posted over the renderer messaging channel
        // (used by the kernel API bundled with the renderer when the notebook preload
        // script is not present in this webview) are routed to the widget coordinator.
        if (message && typeof message === 'object' && 'type' in message) {
            this.routeRendererChannelKernelMessage(comms, editor, message);
        }
    }
    private routeRendererChannelKernelMessage(
        comms: NotebookRendererMessaging,
        editor: NotebookEditor,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        message: any
    ) {
        const notebook = editor.notebook;
        if (notebook.isClosed || !isJupyterNotebook(notebook)) {
            return;
        }
        let coordinator = this.rendererChannelCoordinators.get(notebook);
        if (!coordinator) {
            coordinator = new CommonMessageCoordinator(notebook, this.serviceContainer);
            this.rendererChannelCoordinators.set(notebook, coordinator);
            this.disposables.push(coordinator);
        }
        let emitter = this.rendererChannelEmitters.get(editor);
        if (!emitter) {
            emitter = new EventEmitter<unknown>();
            this.rendererChannelEmitters.set(editor, emitter);
            coordinator.attach({
                controller: this.controllers.getSelected(notebook)?.controller as NotebookController,
                onDidReceiveMessage: emitter.event,
                postMessage: (msg: unknown) => comms.postMessage(msg as never, editor).then(() => true, () => false),
                // Older hosts' renderer messaging API has no asWebviewUri; fall back to the
                // original URI (only matters for locally-served widget scripts).
                asWebviewUri: (uri: Uri) => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const convert = (comms as any).asWebviewUri;
                    return typeof convert === 'function' ? convert.call(comms, uri, editor) : uri;
                }
            } as IWebviewCommunication);
            this.disposables.push(emitter);
        }
        emitter.fire(message);
    }
    private queryWidgetState(
        comms: NotebookRendererMessaging,
        editor: NotebookEditor,
        message: QueryWidgetStateCommand
    ) {
        const availableModels = this.widgetOutputsPerNotebook.get(editor.notebook);
        const kernelSelected = !!this.controllers.getSelected(editor.notebook);
        const hasWidgetState = !!availableModels?.has(message.model_id);
        comms
            .postMessage(
                { command: 'query-widget-state', model_id: message.model_id, hasWidgetState, kernelSelected },
                editor
            )
            .then(noop, noop);
    }
    private sendWidgetVersionAndState(comms: NotebookRendererMessaging, editor: NotebookEditor) {
        // Support for loading Widget state from ipynb files.
        // Temporarily disabled. See https://github.com/microsoft/vscode-jupyter/issues/11117
        // const metadata = getNotebookMetadata(editor.notebook);
        // const widgetState = metadata?.widgets;

        const kernel = this.kernelProvider.get(editor.notebook);
        // const state =
        //     widgetState && widgetState[WIDGET_STATE_MIMETYPE]
        //         ? widgetState && widgetState[WIDGET_STATE_MIMETYPE].state
        //         : undefined;
        // let versionInWidgetState: 7 | 8 | undefined = undefined;
        // if (state) {
        //     const findModuleWithVersion = Object.keys(state).find((key) =>
        //         ['@jupyter-widgets/base', '@jupyter-widgets/controls'].includes(state[key].model_module)
        //     );
        //     versionInWidgetState =
        //         findModuleWithVersion && state[findModuleWithVersion].model_module_version
        //             ? state[findModuleWithVersion].model_module_version.startsWith('2.')
        //                 ? 8
        //                 : 7
        //             : undefined;
        // }
        const version = kernel?.ipywidgetsVersion; // || versionInWidgetState;
        if (kernel?.ipywidgetsVersion) {
            logger.trace(`IPyWidget version in Kernel is ${kernel?.ipywidgetsVersion}.`);
        }
        // if (versionInWidgetState) {
        //     logger.trace(`IPyWidget version in Kernel is ${versionInWidgetState}.`);
        // }
        // if (kernel?.ipywidgetsVersion && versionInWidgetState) {
        //     logger.warn(
        //         `IPyWidget version in Kernel is ${kernel?.ipywidgetsVersion} and in widget state is ${versionInWidgetState}.}`
        //     );
        // }
        const kernelSelected = !!this.controllers.getSelected(editor.notebook);
        comms
            .postMessage(
                { command: 'ipywidget-renderer-init', version, widgetState: undefined, kernelSelected },
                editor
            )
            .then(noop, noop);
    }
}
