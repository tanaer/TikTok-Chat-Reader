/**
 * Onboarding Guide — Floating checklist, no overlay, no freeze.
 *
 * Instead of driver.js step-by-step overlay (which conflicts with modals and
 * causes page freezes), this uses a small fixed-position checklist card.
 * Target elements get a pulsing ring via CSS class. Steps auto-advance by
 * observing real user actions through DOM polling.
 *
 * Steps:
 *   0  Welcome (auto-shown)
 *   1  添加直播间
 *   2  进入直播间
 *   3  生成 AI 直播复盘
 *   4  AI 客户分析
 *   5  Done
 */

(function () {
    'use strict';

    var STORAGE_KEY = 'monitor_tour_done';
    var STEP_KEY   = 'monitor_tour_step';

    // ── Step completion flags (set by intercepting app functions) ──
    var _recapTriggered = false;
    var _customerAnalysisTriggered = false;

    // Monkey-patch to detect when user triggers these actions
    function installHooks() {
        var origRecap = window.generateSessionAiReview;
        if (typeof origRecap === 'function' && !origRecap._obHooked) {
            window.generateSessionAiReview = function () {
                _recapTriggered = true;
                return origRecap.apply(this, arguments);
            };
            window.generateSessionAiReview._obHooked = true;
        }

        var origAnalysis = window.runRoomCustomerAnalysis;
        if (typeof origAnalysis === 'function' && !origAnalysis._obHooked) {
            window.runRoomCustomerAnalysis = function () {
                _customerAnalysisTriggered = true;
                return origAnalysis.apply(this, arguments);
            };
            window.runRoomCustomerAnalysis._obHooked = true;
        }

        // Hook switchSection to react to page changes
        var origSwitch = window.switchSection;
        if (typeof origSwitch === 'function' && !origSwitch._obHooked) {
            window.switchSection = function () {
                var result = origSwitch.apply(this, arguments);
                onSectionChanged();
                return result;
            };
            window.switchSection._obHooked = true;
        }
    }

    // ── Step definitions ──

    var STEPS = [
        {
            id: 'welcome',
            title: '欢迎使用 TikTok 直播监控',
            desc: '我们已为你准备了 1 个默认直播间、1 次 AI 直播复盘、1 次客户深度分析。跟着下面的步骤快速体验核心功能吧！',
            targets: null,
            section: null,
            check: function () { return true; }
        },
        {
            id: 'addRoom',
            title: '① 添加你的直播间',
            desc: '点击右上角「<b>+ 添加直播间</b>」按钮，输入你想监控的 TikTok 主播用户名。',
            targets: ['#addRoomBtn'],
            section: null,
            check: function () {
                return document.querySelectorAll('#roomListContainer [data-room-id]').length >= 2;
            }
        },
        {
            id: 'enterRoom',
            title: '② 进入直播间',
            desc: '点击任意直播间卡片的「<b>进入</b>」按钮，进入详情页查看实时数据和历史记录。',
            targets: ['#roomListContainer [data-room-id]:first-child'],
            section: null,
            check: function () {
                var s = document.getElementById('section-roomDetail');
                return s && s.offsetHeight > 0;
            }
        },
        {
            id: 'aiRecap',
            title: '③ 生成 AI 直播复盘',
            desc: '在详情页中：<br>1. 用顶部下拉框选择一个<b>历史场次</b><br>2. 切换到「<b>AI 直播复盘</b>」标签页<br>3. 点击「<b>生成 AI 复盘</b>」按钮',
            targets: ['#sessionSelect'],
            section: 'roomDetail',
            // Progressive highlight: session select → AI recap tab → recap button
            activeTargets: function () {
                var sel = document.getElementById('sessionSelect');
                if (!sel || !sel.value || sel.value === 'live') {
                    return ['#sessionSelect'];
                }
                // Session selected — check if AI recap tab is active
                var tabPanel = document.getElementById('tab-timeStats');
                if (tabPanel && !tabPanel.classList.contains('hidden')) {
                    return ['#generateSessionRecapBtn'];
                }
                return ['#tabBtn-timeStats'];
            },
            check: function () {
                return _recapTriggered;
            }
        },
        {
            id: 'aiCustomer',
            title: '④ AI 客户深度分析',
            desc: '在右侧「<b>历史排行榜</b>」中，找到送礼榜排名靠前的用户，点击他旁边的「<b>AI</b>」按钮，然后点击「<b>开始挖掘</b>」。',
            targets: ['#leaderboard-alltime'],
            section: 'roomDetail',
            check: function () {
                return _customerAnalysisTriggered;
            }
        }
    ];

    // ── State ──

    function isDone()    { return localStorage.getItem(STORAGE_KEY) === '1'; }
    function setDone()   { localStorage.setItem(STORAGE_KEY, '1'); localStorage.removeItem(STEP_KEY); }
    function getStep()   { return parseInt(localStorage.getItem(STEP_KEY) || '0', 10); }
    function setStep(n)  { localStorage.setItem(STEP_KEY, String(n)); }

    function getCurrentSection() {
        return window.currentSection || 'roomList';
    }

    // ── UI: Floating card ──

    var panel = null;
    var pollTimer = null;
    var currentHighlights = [];

    function createPanel() {
        if (panel) return;
        panel = document.createElement('div');
        panel.id = 'onboardingPanel';
        panel.innerHTML =
            '<div class="ob-header">' +
                '<span class="ob-badge">新手引导</span>' +
                '<button class="ob-close" title="关闭引导">&times;</button>' +
            '</div>' +
            '<div class="ob-title"></div>' +
            '<div class="ob-desc"></div>' +
            '<div class="ob-footer">' +
                '<button class="ob-skip">跳过引导</button>' +
                '<button class="ob-next">开始</button>' +
            '</div>';
        document.body.appendChild(panel);

        panel.querySelector('.ob-close').onclick = function () { hidePanel(); };
        panel.querySelector('.ob-skip').onclick  = function () { finish(); };
        panel.querySelector('.ob-next').onclick   = function () { onNextClick(); };
    }

    /** Check if the step's required section is currently active */
    function isSectionMatch(step) {
        if (!step.section) return true;
        return getCurrentSection() === step.section;
    }

    function showStep(idx) {
        if (idx >= STEPS.length) { finish(); return; }
        setStep(idx);
        createPanel();

        var step = STEPS[idx];

        // If step requires a specific section and we're not there, hide and wait
        if (!isSectionMatch(step)) {
            hidePanel();
            return;
        }

        panel.querySelector('.ob-title').textContent = step.title;
        panel.querySelector('.ob-desc').innerHTML = step.desc;

        var nextBtn = panel.querySelector('.ob-next');
        if (idx === 0) {
            nextBtn.textContent = '开始体验';
            nextBtn.style.display = '';
        } else {
            nextBtn.style.display = 'none';
        }

        panel.classList.add('ob-visible');

        // Highlight all targets
        clearHighlight();
        if (step.targets) {
            step.targets.forEach(function (selector) {
                var el = document.querySelector(selector);
                if (el) {
                    el._obSelector = selector;
                    el.classList.add('ob-pulse');
                    currentHighlights.push(el);
                }
            });
            // Scroll first target into view if needed
            if (currentHighlights.length > 0) {
                var first = currentHighlights[0];
                var rect = first.getBoundingClientRect();
                if (rect.top < 0 || rect.bottom > window.innerHeight) {
                    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }

        // Start polling for auto-advance (steps 1+)
        stopPoll();
        if (idx > 0) {
            pollTimer = setInterval(function () {
                if (step.check()) {
                    stopPoll();
                    clearHighlight();
                    panel.querySelector('.ob-title').textContent = '✓ ' + step.title;
                    setTimeout(function () {
                        showStep(idx + 1);
                    }, 1200);
                    return;
                }
                // Progressive highlight: if step defines activeTargets(), update pulse dynamically
                if (typeof step.activeTargets === 'function') {
                    var wanted = step.activeTargets();
                    // Build set of currently pulsing selectors
                    var currentSet = {};
                    currentHighlights.forEach(function (el) {
                        currentSet[el._obSelector] = el;
                    });
                    var wantedSet = {};
                    wanted.forEach(function (s) { wantedSet[s] = true; });
                    // Remove pulse from elements no longer wanted
                    currentHighlights = currentHighlights.filter(function (el) {
                        if (!wantedSet[el._obSelector]) {
                            el.classList.remove('ob-pulse');
                            return false;
                        }
                        return true;
                    });
                    // Add pulse to newly wanted elements
                    wanted.forEach(function (selector) {
                        if (!currentSet[selector]) {
                            var el = document.querySelector(selector);
                            if (el) {
                                el._obSelector = selector;
                                el.classList.add('ob-pulse');
                                currentHighlights.push(el);
                            }
                        }
                    });
                } else if (step.targets && currentHighlights.length < step.targets.length) {
                    // Re-apply highlights if elements appeared later
                    step.targets.forEach(function (selector) {
                        var el = document.querySelector(selector);
                        if (el && !el.classList.contains('ob-pulse')) {
                            el.classList.add('ob-pulse');
                            currentHighlights.push(el);
                        }
                    });
                }
            }, 1000);
        }
    }

    /** Called when switchSection fires — re-evaluate current step visibility */
    function onSectionChanged() {
        if (isDone()) return;
        var idx = getStep();
        if (idx < 0 || idx >= STEPS.length) return;

        var step = STEPS[idx];
        if (isSectionMatch(step)) {
            // Section now matches, show the step
            showStep(idx);
        } else {
            // Section doesn't match, hide panel and clear highlights
            hidePanel();
        }
    }

    function onNextClick() {
        var idx = getStep();
        if (idx === 0) {
            showStep(1);
        }
    }

    function clearHighlight() {
        currentHighlights.forEach(function (el) {
            el.classList.remove('ob-pulse');
        });
        currentHighlights = [];
        // Also clean up any stale ones
        document.querySelectorAll('.ob-pulse').forEach(function (el) {
            el.classList.remove('ob-pulse');
        });
    }

    function stopPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function hidePanel() {
        stopPoll();
        clearHighlight();
        if (panel) panel.classList.remove('ob-visible');
    }

    function finish() {
        hidePanel();
        setDone();
        if (panel) { panel.remove(); panel = null; }
        var btn = document.getElementById('startTourBtn');
        if (btn) btn.classList.remove('tour-hint');

        showToast('新手引导完成！AI 分析结果会在 1-3 分钟后通过右上角消息通知推送给你。');
    }

    function showToast(msg) {
        var toast = document.createElement('div');
        toast.className = 'ob-toast';
        toast.textContent = msg;
        document.body.appendChild(toast);
        requestAnimationFrame(function () { toast.classList.add('ob-toast-show'); });
        setTimeout(function () {
            toast.classList.remove('ob-toast-show');
            setTimeout(function () { toast.remove(); }, 400);
        }, 5000);
    }

    // ── Public API ──

    window.startOnboardingTour = function () {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STEP_KEY);
        _recapTriggered = false;
        _customerAnalysisTriggered = false;
        installHooks();
        showStep(0);
    };

    // ── Auto-start ──

    $(document).ready(function () {
        if (isDone()) return;
        installHooks();

        setTimeout(function () {
            if (isDone()) return;
            var step = getStep();
            var btn = document.getElementById('startTourBtn');
            if (btn) btn.classList.add('tour-hint');
            showStep(step);
        }, 1500);
    });

})();
