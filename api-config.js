window.DONATION_API_URL = "https://httpshedajbuenhubgithubiodonationmanagementsystemfinal-fx05jihm.b4a.run/";

(() => {
    const apiBaseUrl = String(window.DONATION_API_URL || "").trim().replace(/\/+$/, "");
    const hostedOnGitHubPages = window.location.hostname.endsWith(".github.io");

    window.apiRequest = (path, options = {}) => {
        if (hostedOnGitHubPages && !apiBaseUrl) {
            return Promise.reject(new Error("Set the API URL in api-config.js before using this GitHub Pages site."));
        }
        return fetch(`${apiBaseUrl}${path}`, { ...options, credentials: "include" });
    };
})();
