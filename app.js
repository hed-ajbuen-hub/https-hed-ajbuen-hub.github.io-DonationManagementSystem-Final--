const pages = {
    donors: {
        endpoint: "/api/donors",
        columns: ["id", "full_name", "email", "phone", "address"]
    },
    campaigns: {
        endpoint: "/api/campaigns",
        columns: ["id", "title", "target_amount", "current_amount", "status"]
    },
    donations: {
        endpoint: "/api/donations",
        columns: ["donation_number", "donor_name", "campaign_title", "amount", "status"]
    },
    beneficiaries: {
        endpoint: "/api/beneficiaries",
        columns: ["id", "full_name", "classification", "eligibility_status"]
    }
};

const page = pages[document.body.dataset.page];
const form = document.querySelector("#record-form");
const tableBody = document.querySelector("#records-table");
const statusMessage = document.createElement("p");
statusMessage.setAttribute("role", "status");
statusMessage.setAttribute("aria-live", "polite");
form.insertAdjacentElement("afterend", statusMessage);
document.querySelectorAll("[data-admin-only]").forEach((section) => {
    section.hidden = true;
});

async function initializeSession() {
    let user;
    try {
        user = await requestJson("/api/auth/me");
    } catch {
        window.location.replace("login.html");
        return false;
    }

    const controls = document.querySelector("[data-session-controls]");
    const identity = document.createElement("span");
    identity.className = "session-user";
    identity.append(document.createTextNode(`${user.username} `));
    const role = document.createElement("strong");
    role.textContent = user.role;
    identity.append(role);
    const logoutButton = document.createElement("button");
    logoutButton.className = "logout-button";
    logoutButton.type = "button";
    logoutButton.textContent = "Sign out";
    logoutButton.addEventListener("click", async () => {
        logoutButton.disabled = true;
        try {
            await requestJson("/api/auth/logout", { method: "POST" });
        } finally {
            window.location.replace("login.html");
        }
    });
    controls.append(identity, logoutButton);

    if (user.role === "admin") {
        document.querySelectorAll("[data-admin-only]").forEach((section) => {
            section.hidden = false;
        });
    }
    return true;
}

function formatMoney(value) {
    return `PHP ${Number(value).toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

function createCell(value) {
    const cell = document.createElement("td");
    cell.textContent = value ?? "";
    return cell;
}

function addStatusCell(row, value) {
    const cell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge";
    if (["Pending", "Ineligible"].includes(value)) {
        badge.classList.add("badge-pending");
    } else if (value === "Completed") {
        badge.classList.add("badge-completed");
    } else {
        badge.classList.add("badge-active");
    }
    badge.textContent = value;
    cell.append(badge);
    row.append(cell);
}

function renderRows(records) {
    tableBody.replaceChildren();
    for (const record of records) {
        const row = document.createElement("tr");
        for (const column of page.columns) {
            if (column === "status" || column === "eligibility_status") {
                addStatusCell(row, record[column]);
            } else if (["target_amount", "current_amount", "amount"].includes(column)) {
                row.append(createCell(formatMoney(record[column])));
            } else {
                row.append(createCell(record[column]));
            }
        }
        tableBody.append(row);
    }
}

async function requestJson(url, options) {
    const response = await window.apiRequest(url, options);
    const responseText = await response.text();
    let result = {};
    try {
        result = responseText ? JSON.parse(responseText) : {};
    } catch {
        if (response.status === 408) {
            throw new Error("The temporary share link timed out. The site owner needs to restart the link.");
        }
        throw new Error(`The server returned an invalid response (HTTP ${response.status}).`);
    }
    if (!response.ok) {
        if (response.status === 408) {
            throw new Error("The temporary share link timed out. The site owner needs to restart the link.");
        }
        throw new Error(result.error || `The request could not be completed (HTTP ${response.status}).`);
    }
    return result;
}

async function loadRecords() {
    renderRows(await requestJson(page.endpoint));
}

async function loadDonationOptions() {
    const [donors, campaigns] = await Promise.all([
        requestJson("/api/donors"),
        requestJson("/api/campaigns")
    ]);
    const donorSelect = form.elements.donorId;
    const campaignSelect = form.elements.campaignId;
    for (const donor of donors) {
        const option = document.createElement("option");
        option.value = donor.id;
        option.textContent = donor.full_name;
        donorSelect.append(option);
    }
    for (const campaign of campaigns) {
        const option = document.createElement("option");
        option.value = campaign.id;
        option.textContent = campaign.title;
        campaignSelect.append(option);
    }
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    statusMessage.textContent = "";
    const submitButton = form.querySelector("button[type='submit']");
    submitButton.disabled = true;
    try {
        await requestJson(page.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.fromEntries(new FormData(form)))
        });
        form.reset();
        statusMessage.textContent = "Saved successfully.";
        await loadRecords();
        if (page === pages.donations) {
            await loadDonationOptions();
        }
    } catch (error) {
        statusMessage.textContent = error.message;
    } finally {
        submitButton.disabled = false;
    }
});

initializeSession().then((authenticated) => {
    if (!authenticated) return;
    return Promise.all([
        loadRecords(),
        page === pages.donations ? loadDonationOptions() : Promise.resolve()
    ]).catch((error) => {
        statusMessage.textContent = error.message;
    });
});