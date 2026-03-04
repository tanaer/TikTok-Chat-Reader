const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'public/index.html');
let content = fs.readFileSync(file, 'utf8');

// Update theme mode
content = content.replace(/data-theme="dark"/g, 'data-theme="dracula"');

// Update body classes and inject background glow
content = content.replace(
    /<body class="bg-base-300 min-h-screen flex flex-col">/,
    `<body class="min-h-screen flex flex-col relative text-base-content">
    <style>
        body::before {
            content: '';
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background: 
                radial-gradient(ellipse at 80% 20%, rgba(123, 44, 191, 0.12) 0%, transparent 50%),
                radial-gradient(ellipse at 20% 80%, rgba(0, 245, 212, 0.08) 0%, transparent 50%);
            pointer-events: none;
            z-index: -1;
        }
        .content-section {
            animation: fadeIn 0.3s ease-out forwards;
        }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        /* Style adjustments to mimic landing pages */
        .card, .modal-box, .detail-tab-content, .bg-base-100 {
            background-color: oklch(var(--b1) / 0.7) !important;
            backdrop-filter: blur(12px) !important;
            border: 1px solid oklch(var(--bc) / 0.08) !important;
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.1) !important;
        }
        .navbar.bg-base-100 {
            background-color: oklch(var(--b1) / 0.6) !important;
            backdrop-filter: blur(16px) !important;
            border-bottom: 1px solid oklch(var(--bc) / 0.05) !important;
        }
        .badge-outline { border-color: oklch(var(--bc)/0.2); }
    </style>`
);

content = content.replace(/<div class="navbar bg-base-100 shadow-lg z-10">/, '<div class="navbar rounded-b-2xl mx-auto w-full max-w-[1600px] shadow-sm z-10 px-4 mb-4">');

fs.writeFileSync(file, content, 'utf8');
console.log('index.html styled!');
