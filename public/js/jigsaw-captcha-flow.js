(function () {
    const MODAL_ID = 'shared-jigsaw-captcha-modal';
    let modalElements = null;
    let activeController = null;

    function ensureModal() {
        if (modalElements) return modalElements;

        let modal = document.getElementById(MODAL_ID);
        if (!modal) {
            modal = document.createElement('dialog');
            modal.id = MODAL_ID;
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-box max-w-md">
                    <div class="flex items-start justify-between gap-3 mb-4">
                        <div>
                            <h3 id="sharedJigsawTitle" class="font-bold text-lg">安全验证</h3>
                            <p id="sharedJigsawTip" class="text-sm text-base-content/60 mt-1">请完成拼图验证后继续操作</p>
                        </div>
                        <button type="button" id="sharedJigsawCloseBtn" class="btn btn-ghost btn-sm">关闭</button>
                    </div>
                    <div id="sharedJigsawError" class="alert alert-error hidden mb-3">
                        <span id="sharedJigsawErrorText"></span>
                    </div>
                    <div id="sharedJigsawWidgetWrap" class="flex justify-center min-h-[190px]"></div>
                    <div id="sharedJigsawStatus" class="text-sm text-base-content/55 mt-3 min-h-6"></div>
                </div>
                <form method="dialog" class="modal-backdrop">
                    <button type="button" id="sharedJigsawBackdropBtn">close</button>
                </form>
            `;
            document.body.appendChild(modal);
        }

        modalElements = {
            modal,
            title: modal.querySelector('#sharedJigsawTitle'),
            tip: modal.querySelector('#sharedJigsawTip'),
            error: modal.querySelector('#sharedJigsawError'),
            errorText: modal.querySelector('#sharedJigsawErrorText'),
            widgetWrap: modal.querySelector('#sharedJigsawWidgetWrap'),
            status: modal.querySelector('#sharedJigsawStatus'),
            closeBtn: modal.querySelector('#sharedJigsawCloseBtn'),
            backdropBtn: modal.querySelector('#sharedJigsawBackdropBtn'),
        };

        modalElements.closeBtn.addEventListener('click', () => activeController?.cancel());
        modalElements.backdropBtn.addEventListener('click', () => activeController?.cancel());
        modal.addEventListener('close', () => {
            if (activeController) {
                activeController.handleDialogClosed();
            }
        });

        return modalElements;
    }

    function setStatus(message = '', tone = 'muted') {
        const { status } = ensureModal();
        status.textContent = message;
        status.className = 'text-sm mt-3 min-h-6';
        if (!message) {
            status.classList.add('text-base-content/55');
            return;
        }
        if (tone === 'error') status.classList.add('text-error');
        else if (tone === 'success') status.classList.add('text-success');
        else if (tone === 'loading') status.classList.add('text-info');
        else status.classList.add('text-base-content/55');
    }

    function showError(message = '') {
        const { error, errorText } = ensureModal();
        if (!message) {
            error.classList.add('hidden');
            errorText.textContent = '';
            return;
        }
        errorText.textContent = message;
        error.classList.remove('hidden');
    }

    class SharedJigsawCaptchaController {
        constructor(options = {}) {
            this.options = {
                title: '安全验证',
                tip: '请完成拼图验证后继续操作',
                readyText: '拖动滑块完成验证',
                successText: '验证通过，正在继续...',
                purpose: 'login',
                passUrl: '/api/auth/jigsaw/pass',
                buildBody: ({ purpose }) => ({ purpose }),
                ...options,
            };
            this.instance = null;
            this.pending = null;
            this.resolved = false;
            ensureModal();
        }

        async open() {
            if (!window.jigsaw || typeof window.jigsaw.init !== 'function') {
                throw new Error('验证码组件加载失败，请刷新后重试');
            }
            if (this.pending) {
                return this.pending;
            }

            const elements = ensureModal();
            elements.title.textContent = this.options.title;
            elements.tip.textContent = this.options.tip;
            showError('');
            setStatus(this.options.readyText, 'muted');
            this.resolved = false;

            this.pending = new Promise((resolve, reject) => {
                this.resolve = resolve;
                this.reject = reject;
            });

            activeController = this;
            this.renderWidget();
            if (!elements.modal.open) {
                elements.modal.showModal();
            }
            return this.pending;
        }

        renderWidget() {
            const { widgetWrap } = ensureModal();
            widgetWrap.innerHTML = '';
            const mount = document.createElement('div');
            widgetWrap.appendChild(mount);
            showError('');
            setStatus(this.options.readyText, 'muted');

            this.instance = window.jigsaw.init({
                el: mount,
                onSuccess: () => this.handleSuccess(),
                onFail: () => {
                    showError('验证失败，请重试');
                    setStatus('请重新拖动滑块完成验证', 'error');
                },
                onRefresh: () => {
                    showError('');
                    setStatus(this.options.readyText, 'muted');
                }
            });
        }

        async handleSuccess() {
            if (this.resolved) return;
            setStatus(this.options.successText, 'loading');
            showError('');
            try {
                const res = await fetch(this.options.passUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.options.buildBody({ purpose: this.options.purpose })),
                });
                const data = await res.json();
                if (!res.ok || !data.passToken) {
                    throw new Error(data.error || '验证码处理失败，请重试');
                }
                this.resolved = true;
                this.close();
                this.resolve(data);
                this.pending = null;
            } catch (err) {
                showError(err.message || '验证码处理失败，请重试');
                setStatus('请重新完成拼图验证', 'error');
                if (this.instance && typeof this.instance.reset === 'function') {
                    this.instance.reset();
                } else {
                    this.renderWidget();
                }
            }
        }

        cancel() {
            if (this.resolved) return;
            this.close();
            this.reject?.(new Error('已取消验证码验证'));
            this.pending = null;
        }

        handleDialogClosed() {
            if (!this.resolved && this.pending) {
                this.reject?.(new Error('已取消验证码验证'));
                this.pending = null;
            }
            activeController = null;
        }

        close() {
            const { modal } = ensureModal();
            if (modal.open) {
                modal.close();
            }
            activeController = null;
        }
    }

    window.SharedJigsawCaptcha = {
        create(options) {
            return new SharedJigsawCaptchaController(options);
        }
    };
})();
