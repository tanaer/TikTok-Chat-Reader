(function () {
    const MODAL_ID = 'login-image-captcha-modal';
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
                    <h3 class="font-bold text-lg">图形验证码</h3>
                    <p class="text-sm text-base-content/70 mt-1">请输入图中的 5 位数字后继续登录</p>

                    <div id="loginCaptchaModalError" class="alert alert-error hidden mt-4 mb-2">
                        <span id="loginCaptchaModalErrorText"></span>
                    </div>

                    <div class="mt-4">
                        <div class="flex gap-2 items-stretch">
                            <div id="loginCaptchaImage" class="h-14 flex-1 rounded-lg border border-base-300 bg-base-200 overflow-hidden flex items-center justify-center text-sm text-base-content/50">
                                加载中...
                            </div>
                            <button type="button" id="loginCaptchaRefreshBtn" class="btn btn-outline">换一张</button>
                        </div>
                        <input type="text" id="loginCaptchaAnswer" class="input input-bordered w-full mt-3" placeholder="请输入5位图形验证码" maxlength="5" inputmode="numeric">
                    </div>

                    <div class="modal-action">
                        <button type="button" id="loginCaptchaCancelBtn" class="btn btn-ghost">取消</button>
                        <button type="button" id="loginCaptchaSubmitBtn" class="btn btn-primary">确认登录</button>
                    </div>
                </div>
                <form method="dialog" class="modal-backdrop">
                    <button type="button">close</button>
                </form>
            `;
            document.body.appendChild(modal);
        }

        modalElements = {
            modal,
            image: modal.querySelector('#loginCaptchaImage'),
            answer: modal.querySelector('#loginCaptchaAnswer'),
            errorBox: modal.querySelector('#loginCaptchaModalError'),
            errorText: modal.querySelector('#loginCaptchaModalErrorText'),
            refreshBtn: modal.querySelector('#loginCaptchaRefreshBtn'),
            submitBtn: modal.querySelector('#loginCaptchaSubmitBtn'),
            cancelBtn: modal.querySelector('#loginCaptchaCancelBtn')
        };

        modalElements.refreshBtn.addEventListener('click', () => activeController?.refreshCaptcha(true));
        modalElements.submitBtn.addEventListener('click', () => activeController?.submit());
        modalElements.cancelBtn.addEventListener('click', () => activeController?.cancel());
        modalElements.answer.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                activeController?.submit();
            }
        });

        return modalElements;
    }

    class LoginCaptchaController {
        constructor(options = {}) {
            this.options = {
                captchaUrl: '/api/auth/login-captcha',
                onError: (message) => alert(message),
                ...options
            };
            this.captchaToken = '';
            this.pending = null;
            ensureModal();
        }

        renderPlaceholder(message) {
            const { image } = ensureModal();
            image.textContent = message;
        }

        hideError() {
            ensureModal().errorBox.classList.add('hidden');
        }

        showError(message) {
            const { errorBox, errorText } = ensureModal();
            errorText.textContent = message;
            errorBox.classList.remove('hidden');
        }

        async open(initialError = '') {
            if (this.pending) return this.pending;
            const { modal, answer } = ensureModal();
            activeController = this;
            this.captchaToken = '';
            answer.value = '';
            if (initialError) this.showError(initialError);
            else this.hideError();
            this.renderPlaceholder('加载中...');
            if (!modal.open) {
                modal.showModal();
            }
            this.pending = new Promise((resolve, reject) => {
                this._resolve = resolve;
                this._reject = reject;
            });
            await this.refreshCaptcha(true);
            setTimeout(() => answer.focus(), 0);
            return this.pending;
        }

        close() {
            const { modal, answer } = ensureModal();
            answer.value = '';
            if (modal.open) {
                modal.close();
            }
            if (activeController === this) activeController = null;
            this.pending = null;
        }

        cancel() {
            this.close();
            if (typeof this._reject === 'function') {
                this._reject(new Error('已取消验证码验证'));
            }
        }

        async refreshCaptcha(force = false) {
            if (!force && this.captchaToken) return;
            this.hideError();
            this.renderPlaceholder('加载中...');
            try {
                const res = await fetch(this.options.captchaUrl, { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) {
                    this.captchaToken = '';
                    this.renderPlaceholder(data.error || '验证码加载失败');
                    return;
                }
                this.captchaToken = data.captchaToken || '';
                ensureModal().image.innerHTML = data.svg || '';
                ensureModal().answer.value = '';
            } catch {
                this.captchaToken = '';
                this.renderPlaceholder('验证码加载失败，请重试');
            }
        }

        submit() {
            const { answer } = ensureModal();
            const captchaAnswer = answer.value.trim();
            if (!this.captchaToken) {
                this.showError('验证码加载失败，请刷新后重试');
                return;
            }
            if (!/^\d{5}$/.test(captchaAnswer)) {
                this.showError('请输入5位图形验证码');
                return;
            }
            const payload = { captchaToken: this.captchaToken, captchaAnswer };
            this.close();
            if (typeof this._resolve === 'function') {
                this._resolve(payload);
            }
        }
    }

    window.LoginImageCaptcha = {
        create(options) {
            return new LoginCaptchaController(options);
        }
    };
})();
