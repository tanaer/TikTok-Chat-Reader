(function () {
    function qs(target) {
        if (!target) return null;
        return typeof target === 'string' ? document.querySelector(target) : target;
    }

    function randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function createBackgroundSvg(width, height) {
        const palettes = [
            ['#0f172a', '#1d4ed8', '#38bdf8'],
            ['#1f2937', '#7c3aed', '#06b6d4'],
            ['#0b1120', '#2563eb', '#14b8a6'],
            ['#111827', '#9333ea', '#22c55e']
        ];
        const [base, accent, glow] = palettes[randomInt(0, palettes.length - 1)];
        const circles = Array.from({ length: 9 }).map(() => {
            const radius = randomInt(10, 34);
            const x = randomInt(0, width);
            const y = randomInt(0, height);
            const opacity = (Math.random() * 0.18 + 0.08).toFixed(2);
            const color = Math.random() > 0.5 ? accent : glow;
            return `<circle cx="${x}" cy="${y}" r="${radius}" fill="${color}" opacity="${opacity}" />`;
        }).join('');
        const lines = Array.from({ length: 7 }).map(() => {
            const x1 = randomInt(0, width);
            const y1 = randomInt(0, height);
            const x2 = randomInt(0, width);
            const y2 = randomInt(0, height);
            const opacity = (Math.random() * 0.18 + 0.08).toFixed(2);
            return `<path d="M${x1} ${y1} Q ${randomInt(0, width)} ${randomInt(0, height)} ${x2} ${y2}" stroke="#ffffff" stroke-opacity="${opacity}" stroke-width="${randomInt(1, 2)}" fill="none" />`;
        }).join('');
        const blocks = Array.from({ length: 10 }).map(() => {
            const x = randomInt(0, width - 28);
            const y = randomInt(0, height - 28);
            const w = randomInt(10, 30);
            const h = randomInt(10, 30);
            const opacity = (Math.random() * 0.12 + 0.06).toFixed(2);
            return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#ffffff" opacity="${opacity}" />`;
        }).join('');
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
                <defs>
                    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stop-color="${base}" />
                        <stop offset="60%" stop-color="${accent}" />
                        <stop offset="100%" stop-color="${glow}" />
                    </linearGradient>
                </defs>
                <rect width="100%" height="100%" rx="14" fill="url(#g)" />
                ${circles}
                ${lines}
                ${blocks}
            </svg>
        `.trim();
        return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
    }

    function setStatus(element, message, tone = 'muted') {
        if (!element) return;
        element.textContent = message || '';
        element.className = 'slider-captcha-status';
        if (!message) return;
        if (tone === 'success') element.classList.add('is-success');
        else if (tone === 'error') element.classList.add('is-error');
        else if (tone === 'loading') element.classList.add('is-loading');
    }

    class SharedSliderCaptchaFlow {
        constructor(options = {}) {
            this.options = {
                purpose: 'login',
                widget: null,
                status: null,
                readyText: '请完成滑块验证',
                successText: '验证通过，可继续登录',
                width: 280,
                height: 155,
                onVerified: null,
                onError: null,
                onReset: null,
                ...options,
            };
            this.widget = qs(this.options.widget);
            this.status = qs(this.options.status);
            this.instance = null;
            this.passToken = '';
            this.expiresAt = 0;
            this.dragStartedAt = 0;
            this.verifying = false;
            this.bindStartTime = this.captureDragStart.bind(this);
            this.init();
        }

        init() {
            if (!this.widget || !window.sliderCaptcha) {
                return;
            }

            this.widget.classList.add('slider-captcha-widget');
            this.widget.addEventListener('mousedown', this.bindStartTime, true);
            this.widget.addEventListener('touchstart', this.bindStartTime, { passive: true, capture: true });

            this.instance = sliderCaptcha({
                id: this.widget.id,
                width: this.options.width,
                height: this.options.height,
                repeatIcon: '',
                loadingText: '加载验证中...',
                failedText: '验证失败，请重试',
                barText: '拖动滑块完成验证',
                setSrc: () => createBackgroundSvg(this.options.width - 2, this.options.height),
                onSuccess: () => this.handleLocalSuccess(),
                onFail: () => this.handleLocalFail(),
                onRefresh: () => this.reset(this.options.readyText, 'muted', { silentWidgetReset: true }),
            });

            setStatus(this.status, this.options.readyText, 'muted');
        }

        captureDragStart() {
            this.dragStartedAt = Date.now();
            if (this.passToken) {
                this.clearPass();
            }
            if (!this.verifying) {
                setStatus(this.status, '正在校验滑动轨迹...', 'loading');
            }
        }

        clearPass() {
            this.passToken = '';
            this.expiresAt = 0;
        }

        async handleLocalSuccess() {
            if (!this.instance || this.verifying) return;

            const trail = Array.isArray(this.instance.trail) ? this.instance.trail.slice() : [];
            const durationMs = Math.max(0, Date.now() - (this.dragStartedAt || Date.now()));

            this.verifying = true;
            setStatus(this.status, '正在提交验证...', 'loading');

            try {
                const res = await fetch('/api/auth/slider-captcha/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        purpose: this.options.purpose,
                        trail,
                        durationMs
                    })
                });
                const data = await res.json();
                if (!res.ok || !data.passToken) {
                    throw new Error(data.error || '滑块验证失败，请重试');
                }

                this.passToken = data.passToken;
                this.expiresAt = Date.now() + (Number(data.expiresIn || 0) * 1000);
                setStatus(this.status, this.options.successText, 'success');
                if (typeof this.options.onVerified === 'function') {
                    this.options.onVerified(data);
                }
            } catch (err) {
                this.reset(err.message || '滑块验证失败，请重试');
                if (typeof this.options.onError === 'function') {
                    this.options.onError(err.message || '滑块验证失败，请重试');
                }
            } finally {
                this.verifying = false;
            }
        }

        handleLocalFail() {
            this.clearPass();
            setStatus(this.status, '滑块未通过，请重试', 'error');
        }

        getPassToken() {
            if (!this.passToken) return '';
            if (this.expiresAt && Date.now() > this.expiresAt) {
                this.reset('滑块验证已过期，请重新验证');
                return '';
            }
            return this.passToken;
        }

        isVerified() {
            return !!this.getPassToken();
        }

        reset(message = this.options.readyText, tone = 'error', { silentWidgetReset = false } = {}) {
            this.clearPass();
            this.dragStartedAt = 0;
            this.verifying = false;
            if (!silentWidgetReset && this.instance && typeof this.instance.reset === 'function') {
                this.instance.reset();
            }
            setStatus(this.status, message, tone);
            if (typeof this.options.onReset === 'function') {
                this.options.onReset();
            }
        }
    }

    window.SharedSliderCaptcha = {
        create(options) {
            return new SharedSliderCaptchaFlow(options);
        }
    };
})();
