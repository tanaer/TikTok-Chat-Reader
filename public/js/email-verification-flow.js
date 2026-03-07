(function () {
    const MODAL_ID = 'shared-email-captcha-modal';
    let modalElements = null;
    let activeController = null;

    function qs(target) {
        if (!target) return null;
        return typeof target === 'string' ? document.querySelector(target) : target;
    }

    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
    }

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
                    <p class="text-sm text-base-content/70 mt-1">请输入图中的 5 位数字后发送邮箱验证码</p>

                    <div id="sharedCaptchaModalError" class="alert alert-error hidden mt-4 mb-2">
                        <span id="sharedCaptchaModalErrorText"></span>
                    </div>

                    <div class="mt-4">
                        <div class="flex gap-2 items-stretch">
                            <div id="sharedCaptchaImage" class="h-14 flex-1 rounded-lg border border-base-300 bg-base-200 overflow-hidden flex items-center justify-center text-sm text-base-content/50">
                                加载中...
                            </div>
                            <button type="button" id="sharedRefreshCaptchaBtn" class="btn btn-outline">换一张</button>
                        </div>
                        <input type="text" id="sharedCaptchaAnswer" class="input input-bordered w-full mt-3" placeholder="请输入5位图形验证码" maxlength="5" inputmode="numeric">
                    </div>

                    <div class="modal-action">
                        <button type="button" id="sharedCaptchaCancelBtn" class="btn btn-ghost">取消</button>
                        <button type="button" id="sharedCaptchaSubmitBtn" class="btn btn-primary">确认发送</button>
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
            image: modal.querySelector('#sharedCaptchaImage'),
            answer: modal.querySelector('#sharedCaptchaAnswer'),
            errorBox: modal.querySelector('#sharedCaptchaModalError'),
            errorText: modal.querySelector('#sharedCaptchaModalErrorText'),
            refreshBtn: modal.querySelector('#sharedRefreshCaptchaBtn'),
            submitBtn: modal.querySelector('#sharedCaptchaSubmitBtn'),
            cancelBtn: modal.querySelector('#sharedCaptchaCancelBtn')
        };

        modalElements.refreshBtn.addEventListener('click', () => activeController?.refreshCaptcha(true));
        modalElements.submitBtn.addEventListener('click', () => activeController?.submitCaptchaAndSend());
        modalElements.cancelBtn.addEventListener('click', () => activeController?.closeModal());
        modalElements.answer.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                activeController?.submitCaptchaAndSend();
            }
        });

        return modalElements;
    }

    class EmailVerificationController {
        constructor(options = {}) {
            this.options = {
                purpose: 'register',
                sendUrl: '/api/auth/send-code',
                cooldownSeconds: 60,
                useAuth: false,
                checkingText: '校验中...',
                sendingText: '发送中...',
                onError: (msg) => alert(msg),
                onSent: () => {},
                ...options
            };
            this.emailInput = qs(this.options.emailInput);
            this.sendButton = qs(this.options.sendButton);
            this.captchaToken = '';
            this.captchaEmail = '';
            this.cooldown = 0;
            this.cooldownTimer = null;
            this.submitting = false;
            this.prechecking = false;
            this.boundInputHandler = null;
            ensureModal();
            this.bind();
        }

        bind() {
            if (!this.sendButton) return;
            this.sendButton.addEventListener('click', () => this.handleSendClick());
            if (this.emailInput && !this.options.getEmail) {
                this.boundInputHandler = () => {
                    const normalized = this.getNormalizedEmail();
                    if (normalized !== this.captchaEmail) {
                        this.clearCaptchaState('邮箱变更后请重新获取验证码');
                    }
                    this.syncButtonState();
                };
                this.emailInput.addEventListener('input', this.boundInputHandler);
            }
            this.syncButtonState();
        }

        getEmail() {
            if (typeof this.options.getEmail === 'function') {
                return String(this.options.getEmail() || '').trim();
            }
            return String(this.emailInput?.value || '').trim();
        }

        getNormalizedEmail() {
            return this.getEmail().toLowerCase();
        }

        setError(message) {
            if (typeof this.options.onError === 'function') {
                this.options.onError(message);
            }
        }

        renderPlaceholder(message) {
            const { image } = ensureModal();
            image.textContent = message;
        }

        showModalError(message) {
            const { errorBox, errorText } = ensureModal();
            errorText.textContent = message;
            errorBox.classList.remove('hidden');
        }

        hideModalError() {
            ensureModal().errorBox.classList.add('hidden');
        }

        openModal() {
            const { modal, answer } = ensureModal();
            activeController = this;
            this.hideModalError();
            if (!modal.open) {
                modal.showModal();
            }
            setTimeout(() => answer.focus(), 0);
        }

        closeModal() {
            const { modal, answer } = ensureModal();
            this.hideModalError();
            answer.value = '';
            if (modal.open) {
                modal.close();
            }
            if (activeController === this) {
                activeController = null;
            }
        }

        clearCaptchaState(message = '请输入邮箱后加载验证码') {
            this.captchaToken = '';
            this.captchaEmail = '';
            const { answer } = ensureModal();
            answer.value = '';
            this.hideModalError();
            this.renderPlaceholder(message);
        }

        setSubmittingState(loading) {
            this.submitting = loading;
            const { refreshBtn, submitBtn } = ensureModal();
            refreshBtn.disabled = loading;
            submitBtn.disabled = loading;
            submitBtn.textContent = loading ? this.options.sendingText : '确认发送';
            this.syncButtonState();
        }

        syncButtonState() {
            if (!this.sendButton) return;
            const disabledByOption = typeof this.options.isDisabled === 'function' ? this.options.isDisabled() : false;
            const disabledByEmail = !isValidEmail(this.getEmail());
            this.sendButton.disabled = disabledByOption || disabledByEmail || this.cooldown > 0 || this.submitting || this.prechecking;

            if (this.cooldown > 0) {
                this.sendButton.textContent = `${this.cooldown}s`;
                return;
            }
            if (this.prechecking) {
                this.sendButton.textContent = this.options.checkingText;
                return;
            }
            if (this.submitting) {
                this.sendButton.textContent = this.options.sendingText;
                return;
            }
            this.sendButton.textContent = this.options.buttonText || '发送验证码';
        }

        startCooldown() {
            clearInterval(this.cooldownTimer);
            this.cooldown = Number(this.options.cooldownSeconds || 60);
            this.syncButtonState();
            this.cooldownTimer = setInterval(() => {
                this.cooldown -= 1;
                if (this.cooldown <= 0) {
                    clearInterval(this.cooldownTimer);
                    this.cooldown = 0;
                    this.syncButtonState();
                    return;
                }
                this.sendButton.textContent = `${this.cooldown}s`;
            }, 1000);
        }

        reset() {
            clearInterval(this.cooldownTimer);
            this.cooldownTimer = null;
            this.cooldown = 0;
            this.submitting = false;
            this.prechecking = false;
            this.clearCaptchaState();
            this.syncButtonState();
        }

        async runBeforeOpen(email) {
            if (typeof this.options.beforeOpen !== 'function') {
                return true;
            }

            this.prechecking = true;
            this.syncButtonState();
            try {
                const result = await this.options.beforeOpen(email);
                if (result === false) {
                    return false;
                }
                if (typeof result === 'string' && result) {
                    this.setError(result);
                    return false;
                }
                if (result && typeof result === 'object' && result.ok === false) {
                    this.setError(result.error || '校验失败，请稍后重试');
                    return false;
                }
                return true;
            } catch (err) {
                this.setError(err?.message || '校验失败，请稍后重试');
                return false;
            } finally {
                this.prechecking = false;
                this.syncButtonState();
            }
        }

        async handleSendClick() {
            if (this.submitting || this.prechecking || this.cooldown > 0) {
                return;
            }

            const email = this.getEmail();
            if (!isValidEmail(email)) {
                this.setError('请先输入有效的邮箱地址');
                return;
            }

            const allowed = await this.runBeforeOpen(email);
            if (!allowed) {
                return;
            }

            this.openModal();
            if (!this.captchaToken || this.captchaEmail !== email.toLowerCase()) {
                await this.refreshCaptcha(true);
            }
            if (!this.captchaToken) {
                this.showModalError('图形验证码加载失败，请刷新后重试');
            }
        }

        async refreshCaptcha(force = false) {
            const email = this.getEmail();
            if (!isValidEmail(email)) {
                this.clearCaptchaState('请输入邮箱后加载验证码');
                return;
            }
            const normalizedEmail = email.toLowerCase();
            if (!force && this.captchaToken && this.captchaEmail === normalizedEmail) {
                return;
            }

            this.hideModalError();
            this.renderPlaceholder('加载中...');
            try {
                const res = await fetch(`/api/auth/captcha?purpose=send-code&email=${encodeURIComponent(normalizedEmail)}`, { cache: 'no-store' });
                const data = await res.json();
                if (!res.ok) {
                    this.clearCaptchaState(data.error || '验证码加载失败');
                    return;
                }
                this.captchaToken = data.captchaToken || '';
                this.captchaEmail = normalizedEmail;
                ensureModal().image.innerHTML = data.svg || '';
                ensureModal().answer.value = '';
            } catch {
                this.clearCaptchaState('验证码加载失败，请重试');
            }
        }

        buildRequestBody({ email, captchaToken, captchaAnswer }) {
            if (typeof this.options.buildBody === 'function') {
                return this.options.buildBody({ email, captchaToken, captchaAnswer, purpose: this.options.purpose });
            }
            return { email, captchaToken, captchaAnswer, purpose: this.options.purpose };
        }

        async submitCaptchaAndSend() {
            if (this.submitting) {
                return;
            }

            const email = this.getEmail();
            const { answer } = ensureModal();
            const captchaAnswer = answer.value.trim();

            if (!isValidEmail(email)) {
                this.closeModal();
                this.setError('请先输入有效的邮箱地址');
                return;
            }

            if (!this.captchaToken || this.captchaEmail !== email.toLowerCase()) {
                await this.refreshCaptcha(true);
                if (!this.captchaToken) {
                    this.showModalError('图形验证码加载失败，请刷新后重试');
                    return;
                }
            }

            if (!/^\d{5}$/.test(captchaAnswer)) {
                this.showModalError('请输入5位图形验证码');
                return;
            }

            const body = this.buildRequestBody({
                email,
                captchaToken: this.captchaToken,
                captchaAnswer
            });
            const requester = this.options.useAuth && window.Auth
                ? (url, init) => window.Auth.apiFetch(url, init)
                : (url, init) => fetch(url, init);

            this.closeModal();
            this.clearCaptchaState();
            this.setSubmittingState(true);

            try {
                const res = await requester(this.options.sendUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json();
                if (res.ok) {
                    this.startCooldown();
                    this.options.onSent(data);
                    return;
                }
                this.setError(data.error || '发送失败');
            } catch {
                this.setError('网络错误');
            } finally {
                this.setSubmittingState(false);
            }
        }
    }

    window.EmailVerificationFlow = {
        create(options) {
            return new EmailVerificationController(options);
        }
    };
})();
