const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081/api";

interface AuthTokens {
    accessToken: string;
    refreshToken: string;
}

interface User {
    id: number;
    email: string;
    nickname?: string;
    avatar?: string;
}

// Token storage
export const tokenStorage = {
    get: (): AuthTokens | null => {
        if (typeof window === "undefined") return null;
        const accessToken = localStorage.getItem("accessToken");
        const refreshToken = localStorage.getItem("refreshToken");
        if (!accessToken || !refreshToken) return null;
        return { accessToken, refreshToken };
    },
    set: (tokens: AuthTokens) => {
        localStorage.setItem("accessToken", tokens.accessToken);
        localStorage.setItem("refreshToken", tokens.refreshToken);
    },
    clear: () => {
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
        localStorage.removeItem("user");
    }
};

// User storage
export const userStorage = {
    get: (): User | null => {
        if (typeof window === "undefined") return null;
        const user = localStorage.getItem("user");
        return user ? JSON.parse(user) : null;
    },
    set: (user: User) => {
        localStorage.setItem("user", JSON.stringify(user));
    }
};

// API client with auth
async function apiFetch(
    endpoint: string,
    options: RequestInit = {}
): Promise<any> {
    const tokens = tokenStorage.get();

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(options.headers as Record<string, string>)
    };

    if (tokens?.accessToken) {
        headers["Authorization"] = `Bearer ${tokens.accessToken}`;
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers
    });

    // Handle token refresh
    if (response.status === 401 && tokens?.refreshToken) {
        try {
            const refreshResponse = await fetch(`${API_BASE}/auth/refresh`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refreshToken: tokens.refreshToken })
            });

            if (refreshResponse.ok) {
                const newTokens = await refreshResponse.json();
                tokenStorage.set(newTokens);

                // Retry original request
                headers["Authorization"] = `Bearer ${newTokens.accessToken}`;
                return fetch(`${API_BASE}${endpoint}`, { ...options, headers }).then(r => r.json());
            }
        } catch {
            tokenStorage.clear();
            window.location.href = "/login";
        }
    }

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || "请求失败");
    }

    return data;
}

// Auth API
export const authApi = {
    register: async (email: string, password: string, nickname?: string) => {
        const data = await apiFetch("/auth/register", {
            method: "POST",
            body: JSON.stringify({ email, password, nickname })
        });
        tokenStorage.set({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        userStorage.set(data.user);
        return data;
    },

    login: async (email: string, password: string) => {
        const data = await apiFetch("/auth/login", {
            method: "POST",
            body: JSON.stringify({ email, password })
        });
        tokenStorage.set({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        userStorage.set(data.user);
        return data;
    },

    logout: async () => {
        try {
            const tokens = tokenStorage.get();
            if (tokens?.refreshToken) {
                await apiFetch("/auth/logout", {
                    method: "POST",
                    body: JSON.stringify({ refreshToken: tokens.refreshToken })
                });
            }
        } finally {
            tokenStorage.clear();
        }
    },

    getMe: () => apiFetch("/auth/me"),

    updateProfile: (data: { nickname?: string; avatar?: string }) =>
        apiFetch("/auth/profile", { method: "PUT", body: JSON.stringify(data) }),

    changePassword: (oldPassword: string, newPassword: string) =>
        apiFetch("/auth/password", {
            method: "PUT",
            body: JSON.stringify({ oldPassword, newPassword })
        })
};

// Subscription API
export const subscriptionApi = {
    getPlans: () => apiFetch("/plans"),
    getSubscription: () => apiFetch("/subscription"),
    createOrder: (planCode: string, billingCycle: string) =>
        apiFetch("/subscription/create", {
            method: "POST",
            body: JSON.stringify({ planCode, billingCycle })
        }),
    cancel: () => apiFetch("/subscription/cancel", { method: "POST" }),
    getHistory: () => apiFetch("/subscription/history")
};

// Payment API
export const paymentApi = {
    createFutongPay: (orderNo: string, payType: "alipay" | "wxpay") =>
        apiFetch("/payment/futong/create", {
            method: "POST",
            body: JSON.stringify({ orderNo, payType })
        }),

    createStripePay: (orderNo: string) =>
        apiFetch("/payment/stripe/create", {
            method: "POST",
            body: JSON.stringify({ orderNo })
        }),

    getStatus: (orderNo: string) => apiFetch(`/payment/status/${orderNo}`),
    getHistory: () => apiFetch("/payment/history")
};

export { apiFetch };
