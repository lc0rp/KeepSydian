import { t } from "../../lang/ui";
import { localizePluginLabel } from "../../lang/display";
import { App, Modal, Setting } from "obsidian";
import {
	TOKEN_HELPER_SOURCE_URL,
	installTokenHelper,
	runTokenHelper,
	type TokenHelperManifest,
	type TokenHelperProgress,
} from "@integrations/google/tokenHelper";
import type KeepSidianPlugin from "main";

interface TokenHelperInstallModalOptions {
	plugin: KeepSidianPlugin;
	manifest: TokenHelperManifest;
	mode: "install" | "update" | "replace";
	onManual: () => void;
	onToken: (oauthToken: string) => Promise<void>;
	onError: (message: string) => Promise<void> | void;
	onComplete?: () => void;
}

export class TokenHelperInstallModal extends Modal {
	private readonly plugin: KeepSidianPlugin;
	private readonly manifest: TokenHelperManifest;
	private readonly mode: "install" | "update" | "replace";
	private readonly onManual: () => void;
	private readonly onToken: (oauthToken: string) => Promise<void>;
	private readonly onError: (message: string) => Promise<void> | void;
	private readonly onComplete?: () => void;
	private progressFillEl: HTMLElement | null = null;
	private progressTextEl: HTMLElement | null = null;
	private primaryButtonEl: HTMLButtonElement | null = null;

	constructor(app: App, options: TokenHelperInstallModalOptions) {
		super(app);
		this.plugin = options.plugin;
		this.manifest = options.manifest;
		this.mode = options.mode;
		this.onManual = options.onManual;
		this.onToken = options.onToken;
		this.onError = options.onError;
		this.onComplete = options.onComplete;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.classList.add("keepsidian-token-helper-modal-shell");
		contentEl.classList.add("keepsidian-token-helper-modal");
		contentEl.createEl("h2", { text: t("onboarding.helper.title") });
		if (this.mode === "update") {
			contentEl.createEl("p", {
				text: t("helper.outdated"),
			});
		}
		if (this.mode === "replace") {
			contentEl.createEl("p", {
				text: t("helper.incompatible"),
			});
		}
		contentEl.createEl("p", {
			text: t("onboarding.helper.description"),
		});
		contentEl.createEl("p", {
			text: t("onboarding.helper.disclosure"),
		});
		const sourceLink = contentEl.createEl("a", {
			text: t("onboarding.helper.source",{url:TOKEN_HELPER_SOURCE_URL}),
			attr: {
				href: TOKEN_HELPER_SOURCE_URL,
				target: "_blank",
				rel: "noopener noreferrer",
			},
		});
		sourceLink.classList.add("keepsidian-token-helper-source");
		const progressEl = contentEl.createDiv("keepsidian-token-helper-progress");
		this.progressFillEl = progressEl.createDiv("keepsidian-token-helper-progress__fill");
		this.progressTextEl = contentEl.createDiv({
			cls: "keepsidian-token-helper-progress__text",
			text: t("common.ready"),
		});
		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText(
						this.mode === "update"
							? t("onboarding.helper.update")
							: this.mode === "replace"
								? t("onboarding.helper.installCompatible")
								: t("onboarding.helper.download")
					)
					.setCta()
					.onClick(() => {
						void this.installAndLaunch();
					});
				this.primaryButtonEl = button.buttonEl;
			})
			.addButton((button) =>
				button.setButtonText(t("onboarding.helper.manual")).onClick(() => {
					this.onManual();
					this.close();
				})
			)
			.addButton((button) =>
				button.setButtonText(t("common.cancel")).onClick(() => {
					this.close();
				})
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.contentEl.classList.remove("keepsidian-token-helper-modal");
		this.modalEl.classList.remove("keepsidian-token-helper-modal-shell");
	}

	private updateProgress(progress: TokenHelperProgress): void {
		if (this.progressTextEl) {
			this.progressTextEl.textContent = localizePluginLabel(progress.message);
		}
		if (this.progressFillEl && typeof progress.percent === "number") {
			this.progressFillEl.style.width = `${Math.max(0, Math.min(100, progress.percent))}%`;
		}
	}

	private async installAndLaunch(): Promise<void> {
		if (this.primaryButtonEl) {
			this.primaryButtonEl.disabled = true;
		}
		try {
			await installTokenHelper(this.plugin, this.manifest, (progress) => this.updateProgress(progress));
			this.updateProgress({ phase: "launch", percent: 100, message: t("onboarding.helper.launching") });
			await runTokenHelper(this.plugin, async (event) => {
				if (event.type === "progress") {
					this.updateProgress(event);
					return;
				}
				if (event.type === "token") {
					await this.onToken(event.oauthToken);
					this.close();
				}
				if (event.type === "error") {
					await this.onError(event.message);
				}
			});
			this.onComplete?.();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.updateProgress({ phase: "install", message });
			await this.onError(message);
			if (this.primaryButtonEl) {
				this.primaryButtonEl.disabled = false;
			}
		}
	}
}
