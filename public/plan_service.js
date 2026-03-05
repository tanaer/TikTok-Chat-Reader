/**
 * PlanService — Centralized subscription plan management
 * 
 * Shared module for loading, rendering, and purchasing subscription plans.
 * Used by: user-center.html, admin.html, landing/index.html
 * 
 * API fields are camelCase (db.js toCamelCase pipeline):
 *   plans[]: id, name, code, priceMonthly, priceQuarterly, priceAnnual,
 *            roomLimit, historyDays, apiRateLimit, featureFlags, aiCreditsMonthly, description
 *   addons[]: id, name, roomCount, priceMonthly, priceQuarterly, priceAnnual
 *   balance: number (cents)
 */
(function () {
    'use strict';

    // ── Cache ────────────────────────────────────────────────
    let _cache = null;
    let _fetchPromise = null; // dedup concurrent calls

    // ── Helpers ──────────────────────────────────────────────
    function fmtCny(cents) {
        return '¥' + (cents / 100).toFixed(2);
    }

    function cycleName(cycle) {
        return { monthly: '月', quarterly: '季', annual: '年' }[cycle] || cycle;
    }

    function cycleLabel(cycle) {
        return { monthly: '月付', quarterly: '季付', annual: '年付' }[cycle] || cycle;
    }

    function priceField(cycle) {
        return { monthly: 'priceMonthly', quarterly: 'priceQuarterly', annual: 'priceAnnual' }[cycle] || 'priceMonthly';
    }

    // ── Core: Load Plans ─────────────────────────────────────
    async function loadPlans(forceRefresh) {
        if (_cache && !forceRefresh) return _cache;
        if (_fetchPromise) return _fetchPromise;

        _fetchPromise = (async () => {
            try {
                const res = await fetch('/api/subscription/plans');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                _cache = {
                    plans: data.plans || [],
                    addons: data.addons || [],
                    balance: data.balance || 0
                };
                return _cache;
            } catch (e) {
                console.error('[PlanService] Failed to load plans:', e);
                throw e;
            } finally {
                _fetchPromise = null;
            }
        })();

        return _fetchPromise;
    }

    function invalidateCache() {
        _cache = null;
    }

    // ── Render: Plan Cards ───────────────────────────────────
    /**
     * Render plan selection cards into a container
     * @param {HTMLElement} container - target element
     * @param {Object[]} plans - plan array from API
     * @param {Object} opts - { cycle, balance, onPurchase(planCode, cycle) }
     */
    function renderPlanCards(container, plans, opts = {}) {
        const cycle = opts.cycle || 'monthly';
        const balance = opts.balance || 0;
        const field = priceField(cycle);

        if (!plans || plans.length === 0) {
            container.innerHTML = '<p class="col-span-3 text-center opacity-40 py-8">暂无可用套餐</p>';
            return;
        }

        container.innerHTML = plans.map(p => {
            const price = p[field] || p.priceMonthly || 0;
            const canAfford = balance >= price;
            const popular = p.code === 'pro';

            return `
            <div class="glass-card p-5 relative ${popular ? 'ring-1 ring-primary/40' : ''}">
                ${popular ? '<div class="badge badge-primary badge-sm absolute -top-2 left-4">最受欢迎</div>' : ''}
                <div class="font-bold text-base mb-1">${p.name}</div>
                <div class="text-3xl font-extrabold text-primary mb-1">
                    ${fmtCny(price)}<span class="text-xs font-normal opacity-40">/${cycleName(cycle)}</span>
                </div>
                ${p.description ? `<p class="text-xs opacity-40 mb-3">${p.description}</p>` : '<div class="mb-3"></div>'}
                <ul class="text-xs opacity-60 space-y-1.5 mb-5">
                    <li>📺 ${p.roomLimit === -1 ? '无限' : p.roomLimit} 个房间</li>
                    <li>🤖 AI分析 ${p.aiCreditsMonthly || 0}/月</li>
                    <li>📅 历史数据 ${p.historyDays === -1 ? '无限' : (p.historyDays || 7)} 天</li>
                </ul>
                <button onclick="PlanService.purchasePlan('${p.code}','${cycle}','${p.name}',${price})"
                    class="btn btn-primary btn-sm btn-block rounded-lg ${!canAfford ? 'btn-disabled opacity-40' : ''}">
                    ${canAfford ? '立即订阅' : '余额不足'}
                </button>
            </div>`;
        }).join('');
    }

    // ── Render: Addon Cards ──────────────────────────────────
    function renderAddonCards(container, addons, opts = {}) {
        const balance = opts.balance || 0;

        if (!addons || addons.length === 0) {
            container.innerHTML = '<p class="col-span-2 text-center opacity-40 text-sm py-4">暂无加量包</p>';
            return;
        }

        container.innerHTML = addons.map(a => {
            const price = a.priceMonthly || 0;
            const canAfford = balance >= price;
            return `
            <div class="glass-card p-4 flex justify-between items-center">
                <div>
                    <div class="font-semibold">+${a.roomCount || 0} 个房间</div>
                    <div class="text-xs opacity-40">${a.name} · ${fmtCny(price)}/月</div>
                </div>
                <button onclick="PlanService.purchaseAddon(${a.id},'${a.name}',${price})"
                    class="btn btn-sm btn-outline rounded-lg ${!canAfford ? 'btn-disabled opacity-40' : ''}">
                    ${canAfford ? '购买' : '余额不足'}
                </button>
            </div>`;
        }).join('');
    }

    function renderPlanTableRows(plans) {
        if (!plans || plans.length === 0) {
            return '<tr><td colspan="6" class="text-center py-10 opacity-30">无套餐数据</td></tr>';
        }
        return plans.map(p => `<tr>
            <td class="font-semibold">${p.name}</td>
            <td class="font-mono text-xs opacity-60">${p.code}</td>
            <td>${p.roomLimit === -1 ? '∞' : p.roomLimit}</td>
            <td class="font-bold">${fmtCny(p.priceMonthly || 0)}</td>
            <td><span class="badge ${p.isActive !== false ? 'badge-success' : 'badge-ghost'} badge-xs">${p.isActive !== false ? '启用' : '禁用'}</span></td>
            <td>
                <div class="flex gap-2">
                    <button class="btn btn-xs btn-outline rounded-lg" onclick='window.editPlan(${JSON.stringify(p).replace(/'/g, "&#39;")})'>编辑</button>
                    ${p.code !== 'free' ? `<button class="btn btn-xs btn-error btn-outline rounded-lg" onclick="deletePlan(${p.id})">删除</button>` : ''}
                </div>
            </td>
        </tr>`).join('');
    }

    function renderAddonTableRows(addons) {
        if (!addons || addons.length === 0) {
            return '<tr><td colspan="5" class="text-center py-10 opacity-30">无加量包数据</td></tr>';
        }
        return addons.map(a => `<tr>
            <td class="font-semibold">${a.name}</td>
            <td class="font-mono text-xs opacity-60">${a.code}</td>
            <td>+${a.roomCount}</td>
            <td class="font-bold">${fmtCny(a.priceMonthly || 0)}</td>
            <td>
                <div class="flex gap-2">
                    <button class="btn btn-xs btn-outline rounded-lg" onclick='window.editAddon(${JSON.stringify(a).replace(/'/g, "&#39;")})'>编辑</button>
                    <button class="btn btn-xs btn-error btn-outline rounded-lg" onclick="deleteAddon(${a.id})">删除</button>
                </div>
            </td>
        </tr>`).join('');
    }

    // ── Render: Landing Pricing Card ─────────────────────────
    function renderLandingPlanCards(container, plans, opts = {}) {
        const isAnnual = opts.isAnnual || false;
        const isLoggedIn = opts.isLoggedIn || false;
        const actionUrl = isLoggedIn ? '/landing/user-center.html' : '/landing/register.html';
        const actionText = isLoggedIn ? '用户中心' : '注册后购买';

        container.innerHTML = plans.map(p => {
            // Free plan
            if (p.code === 'free') return `
            <div class="plan-card">
                <div class="badge badge-ghost badge-sm mb-4 self-start">免费版</div>
                <h3 class="text-xl font-bold mb-2">${p.name}</h3>
                <p class="text-sm opacity-40 mb-6 flex-grow">${p.description || '免费体验基础监控功能'}</p>
                <div class="text-4xl font-extrabold mb-6">¥0</div>
                <ul class="space-y-3 mb-8 text-sm opacity-70">
                    <li class="flex items-center gap-2">✓ ${p.roomLimit} 个监控房间</li>
                    <li class="flex items-center gap-2 opacity-40">✗ 不支持加量包</li>
                    <li class="flex items-center gap-2 opacity-40">✗ 录制/AI分析不可用</li>
                </ul>
                <a href="${isLoggedIn ? '/' : '/landing/register.html'}" class="btn btn-outline btn-block rounded-xl">免费使用</a>
            </div>`;

            // Paid plans
            const price = isAnnual ? (p.priceAnnual || p.priceMonthly) : (p.priceMonthly || 0);
            const period = isAnnual ? '年' : '月';
            const isFeatured = p.code === 'pro';
            const cls = isFeatured ? 'plan-card featured' : 'plan-card';

            return `
            <div class="${cls} ${isFeatured ? 'relative' : ''}">
                ${isFeatured ? '<div class="absolute -top-4 left-1/2 -translate-x-1/2"><span class="badge badge-primary px-4 py-2 font-bold shadow-lg shadow-indigo-500/20">最畅销</span></div>' : ''}
                <h3 class="text-xl font-bold mb-2 ${isFeatured ? 'gradient-text-primary' : ''}">${p.name}</h3>
                <p class="text-sm opacity-40 mb-6 flex-grow">${p.description || ''}</p>
                <div class="mb-6">
                    <span class="text-4xl font-extrabold">¥${(price / 100).toFixed(0)}</span>
                    <span class="opacity-40 text-sm">/${period}</span>
                </div>
                <ul class="space-y-3 mb-8 text-sm opacity-70">
                    <li class="flex items-center gap-2"><span class="text-primary">✓</span> 基础监控 <strong class="text-base-content">${p.roomLimit === -1 ? '无限' : p.roomLimit}</strong> 个房间</li>
                    <li class="flex items-center gap-2"><span class="text-primary">✓</span> 房间加量包可购</li>
                    <li class="flex items-center gap-2"><span class="text-primary">✓</span> 解锁自动录制功能</li>
                    <li class="flex items-center gap-2"><span class="text-primary">✓</span> AI 深度用户分析</li>
                </ul>
                <a href="${actionUrl}" class="btn ${isFeatured ? 'gradient-btn text-white' : 'btn-outline'} btn-block rounded-xl">${actionText}</a>
            </div>`;
        }).join('');

        container.classList.remove('hidden');
    }

    // ── Plan Modal ───────────────────────────────────────────
    let _modalInjected = false;
    let _activeCycle = 'monthly';

    function _ensureModal() {
        if (_modalInjected) return;
        _modalInjected = true;

        const tpl = document.createElement('div');
        tpl.innerHTML = `
        <dialog id="planServiceModal" class="modal modal-bottom sm:modal-middle">
            <div class="modal-box max-w-4xl" style="background:rgba(15,15,25,0.97);border:1px solid rgba(255,255,255,0.08)">
                <div class="flex justify-between items-center mb-6">
                    <div>
                        <h3 class="font-bold text-xl">订阅套餐</h3>
                        <p class="text-xs opacity-40 mt-0.5">当前余额：<span id="psModalBalance" class="text-accent font-bold">—</span></p>
                    </div>
                    <form method="dialog"><button class="btn btn-ghost btn-sm btn-circle">✕</button></form>
                </div>
                <div class="flex gap-1 p-1 rounded-xl w-fit mb-6" style="background:rgba(255,255,255,0.05)">
                    <button class="ps-cycle-btn btn btn-sm rounded-lg" data-cycle="monthly">月付</button>
                    <button class="ps-cycle-btn btn btn-sm rounded-lg opacity-50" data-cycle="quarterly">季付 <span class="badge badge-success badge-xs ml-1">-10%</span></button>
                    <button class="ps-cycle-btn btn btn-sm rounded-lg opacity-50" data-cycle="annual">年付 <span class="badge badge-warning badge-xs ml-1">-25%</span></button>
                </div>
                <div id="psModalPlans" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
                    <div class="text-center py-10 opacity-30 col-span-3"><span class="loading loading-spinner loading-lg"></span></div>
                </div>
                <div id="psAddonSection">
                    <div class="divider my-4 opacity-20">加量包</div>
                    <div id="psModalAddons" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div class="text-center py-6 opacity-30 col-span-2"><span class="loading loading-spinner"></span></div>
                    </div>
                </div>
            </div>
            <form method="dialog" class="modal-backdrop"><button>close</button></form>
        </dialog>`;
        document.body.appendChild(tpl.firstElementChild);

        // Wire billing cycle toggle
        document.querySelectorAll('.ps-cycle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                _activeCycle = btn.dataset.cycle;
                document.querySelectorAll('.ps-cycle-btn').forEach(b => {
                    b.classList.toggle('active', b === btn);
                    b.classList.toggle('opacity-50', b !== btn);
                });
                _renderModalPlans();
            });
        });

        // Set initial active
        const firstBtn = document.querySelector('.ps-cycle-btn[data-cycle="monthly"]');
        if (firstBtn) firstBtn.classList.add('active');
    }

    function _renderModalPlans() {
        if (!_cache) return;
        renderPlanCards(
            document.getElementById('psModalPlans'),
            _cache.plans,
            { cycle: _activeCycle, balance: _cache.balance }
        );
    }

    async function openPlanModal(scrollTo) {
        _ensureModal();
        const modal = document.getElementById('planServiceModal');
        modal.showModal();

        try {
            await loadPlans();
            document.getElementById('psModalBalance').textContent = fmtCny(_cache.balance);
            _renderModalPlans();
            renderAddonCards(
                document.getElementById('psModalAddons'),
                _cache.addons,
                { balance: _cache.balance }
            );
        } catch {
            document.getElementById('psModalPlans').innerHTML =
                '<p class="col-span-3 text-center text-error py-8">套餐加载失败，请关闭后重试</p>';
        }

        if (scrollTo === 'addon') {
            setTimeout(() => {
                const sec = document.getElementById('psAddonSection');
                if (sec) sec.scrollIntoView({ behavior: 'smooth' });
            }, 300);
        }
    }

    // ── Purchase Actions ─────────────────────────────────────
    async function purchasePlan(planCode, billingCycle, planName, price) {
        if (!confirm(`确认订阅「${planName}」？将从余额扣除 ${fmtCny(price)}`)) return;
        try {
            const res = await fetch('/api/subscription/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ planCode, billingCycle })
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error);
            if (typeof showToast === 'function') showToast('订阅成功！', 'success');
            const modal = document.getElementById('planServiceModal');
            if (modal) modal.close();
            invalidateCache();
            // Trigger page reload after short delay
            setTimeout(() => { if (typeof loadData === 'function') loadData(); else location.reload(); }, 800);
        } catch (e) {
            if (typeof showToast === 'function') showToast(e.message || '订阅失败', 'error');
            else alert(e.message || '订阅失败');
        }
    }

    async function purchaseAddon(addonId, addonName, price) {
        if (!confirm(`确认购买「${addonName}」？将从余额扣除 ${fmtCny(price)}`)) return;
        try {
            const res = await fetch('/api/subscription/addon/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ packageId: addonId, billingCycle: 'monthly' })
            });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error);
            if (typeof showToast === 'function') showToast('加量包购买成功！', 'success');
            const modal = document.getElementById('planServiceModal');
            if (modal) modal.close();
            invalidateCache();
            setTimeout(() => { if (typeof loadData === 'function') loadData(); else location.reload(); }, 800);
        } catch (e) {
            if (typeof showToast === 'function') showToast(e.message || '购买失败', 'error');
            else alert(e.message || '购买失败');
        }
    }

    // ── Public API ───────────────────────────────────────────
    window.PlanService = {
        loadPlans,
        invalidateCache,
        renderPlanCards,
        renderAddonCards,
        renderPlanTableRows,
        renderAddonTableRows,
        renderLandingPlanCards,
        openPlanModal,
        purchasePlan,
        purchaseAddon,
        fmtCny
    };
})();
