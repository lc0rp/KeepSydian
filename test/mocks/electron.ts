export interface ConsoleMessageEvent {
    message: string;
    level?: number;
    line?: number;
    sourceId?: string;
}

type ConsoleMessageHandler = (event: ConsoleMessageEvent) => void;

export class WebviewTag extends HTMLElement {
    src = '';
    setAttribute(name: string, value: string): void {
        // Mock implementation
    }
    loadURL(url: string): Promise<void> {
        return Promise.resolve();
    }
    show(): void {}
    hide(): void {}
    getURL(): string {
        return '';
    }
    executeJavaScript(script: string): Promise<void> {
        return Promise.resolve();
    }
    addEventListener(event: 'console-message', handler: ConsoleMessageHandler): void;
    addEventListener(event: string, handler: EventListener): void;
    addEventListener(event: string, handler: EventListener | ConsoleMessageHandler): void {}

    removeEventListener(event: 'console-message', handler: ConsoleMessageHandler): void;
    removeEventListener(event: string, handler: EventListener): void;
    removeEventListener(event: string, handler: EventListener | ConsoleMessageHandler): void {}

    openDevTools(): void {}
    closeDevTools(): void {}
}

// Define the custom element if it hasn't been defined yet
if (!customElements.get('mock-webview')) {
    customElements.define('mock-webview', WebviewTag);
}
