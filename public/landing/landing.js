/**
 * TikTok Monitor Landing Page JavaScript
 */

document.addEventListener('DOMContentLoaded', () => {
    initBillingToggle();
    initSmoothScroll();
});

/**
 * Billing cycle toggle functionality
 */
function initBillingToggle() {
    const buttons = document.querySelectorAll('.billing-btn');
    const prices = document.querySelectorAll('.plan-price .price[data-monthly]');

    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            // Update active state
            buttons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Update prices
            const cycle = btn.dataset.cycle;
            prices.forEach(price => {
                const value = price.dataset[cycle];
                if (value) {
                    price.textContent = `¥${value}`;
                }
            });

            // Update period text
            const periods = document.querySelectorAll('.plan-price .period');
            const periodMap = {
                monthly: '/月',
                quarterly: '/季',
                annual: '/年'
            };
            periods.forEach(p => {
                p.textContent = periodMap[cycle] || '/月';
            });
        });
    });
}

/**
 * Smooth scroll for anchor links
 */
function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
}

/**
 * Load pricing data from API (optional - can use static data)
 */
async function loadPricing() {
    try {
        const response = await fetch('/api/plans');
        const plans = await response.json();
        console.log('Plans loaded:', plans);
        // Could dynamically render pricing cards here
    } catch (err) {
        console.log('Using static pricing data');
    }
}
