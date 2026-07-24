// =========================
// Authentication
// =========================

if (!getToken()) {
    window.location.href = "../index.html";
}

if (getRole() !== "admin") {
    alert("Only Admin can access this page.");
    window.location.href = "../main_dashboard.html";
}
// ================================
// Current Selected Service
// ================================

let selectedService = null;
// =========================
// Message
// =========================

function showMessage(msg, success = true) {

    const box = document.getElementById("msg");

    box.style.display = "block";
    box.innerHTML = msg;

    if (success) {
        box.style.background = "#d4edda";
        box.style.color = "#155724";
        box.style.border = "1px solid #28a745";
    } else {
        box.style.background = "#f8d7da";
        box.style.color = "#721c24";
        box.style.border = "1px solid #dc3545";
    }
}

// =========================
// Create Account
// =========================

document.getElementById("createForm").addEventListener("submit", async function (e) {

    e.preventDefault();

    const btn = document.getElementById("createBtn");

    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Creating...';

    const payload = {

        username: document.getElementById("username").value.trim(),

        password: document.getElementById("password").value,

        confirm_password: document.getElementById("password").value,

        name: document.getElementById("full_name").value.trim(),

        email_id: document.getElementById("email").value.trim(),

        gst_number: "",

        company_name: "",

        mobile_no: document.getElementById("phone").value.trim(),

        role: document.getElementById("role").value

    };

    try {

        const response = await apiFetch("/account/create_account/", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify(payload)

        });

        const data = await response.json();

        if (!response.ok) {

            showMessage(data.detail || "Account creation failed.", false);

            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';

            return;

        }

        showMessage("Account Created Successfully.");

        document.getElementById("createForm").reset();

    }

    catch (err) {

        console.error(err);

        showMessage(err.message, false);

    }

    btn.disabled = false;

    btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';

});

// =========================
// Back Button
// =========================

const backBtn = document.getElementById("backBtn");

if (backBtn) {

    backBtn.addEventListener("click", () => {

        window.location.href = "../main_dashboard.html";

    });

}