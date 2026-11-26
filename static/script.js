
document.addEventListener("DOMContentLoaded", function () {

    // -------------------------------
    // USER AND STORAGE SETTINGS
    // -------------------------------

    const username = document.body.dataset.username || "guest";
    const storageKey = "tabletReminders_" + username;
    const IST_TIME_ZONE = "Asia/Kolkata";

    let reminders = JSON.parse(localStorage.getItem(storageKey) || "[]");

    reminders = reminders.map(item => ({
        ...item,
        medicine: item.medicine || item.name || ""
    }));

    let saveQueue = Promise.resolve();
    let stockItems = [];
    let activeAlarmId = null;
    let alarmAudioContext = null;
    let alarmTimeoutId = null;

    let remindersVisible = 3;

    // -------------------------------
    // DATE AND TIME HELPERS
    // -------------------------------

    function getISTParts(date = new Date()) {
        const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: IST_TIME_ZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23"
        }).formatToParts(date);

        const result = {};

        parts.forEach(part => {
            result[part.type] = part.value;
        });

        return result;
    }

    function getTodayIST() {
        const p = getISTParts();
        return `${p.year}-${p.month}-${p.day}`;
    }

    function getTodayDate() {
        return getTodayIST();
    }

    // -------------------------------
    // EXPIRY DATE HELPERS
    // -------------------------------

    function getExpiryStatus(expiryDate) {

        if (!expiryDate) {
            return null;
        }

        const today = getTodayIST();

        const todayParts = today.split("-").map(Number);
        const expiryParts = expiryDate.split("-").map(Number);

        if (expiryParts.length !== 3 || expiryParts.some(isNaN)) {
            return null;
        }

        const todayUTC = Date.UTC(
            todayParts[0],
            todayParts[1] - 1,
            todayParts[2]
        );

        const expiryUTC = Date.UTC(
            expiryParts[0],
            expiryParts[1] - 1,
            expiryParts[2]
        );

        const daysLeft = Math.ceil(
            (expiryUTC - todayUTC) / (1000 * 60 * 60 * 24)
        );

        if (daysLeft < 0) {
            return {
                status: "Expired",
                color: "#d93025",
                daysLeft: daysLeft
            };
        }

        if (daysLeft === 0) {
            return {
                status: "Expires Today",
                color: "#d93025",
                daysLeft: 0
            };
        }

        if (daysLeft <= 30) {
            return {
                status: "Expiring Soon",
                color: "#e69a00",
                daysLeft: daysLeft
            };
        }

        return {
            status: "Valid",
            color: "#279b65",
            daysLeft: daysLeft
        };
    }

    function formatExpiryDate(expiryDate) {

        if (!expiryDate) return "Not provided";

        const parts = expiryDate.split("-");

        if (parts.length !== 3) return expiryDate;

        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }

    // -------------------------------
    // TIME AND DATE DISPLAY
    // -------------------------------

    function updateClock() {

        const clock = document.getElementById("currentTime");
        const date = document.getElementById("currentDate");

        const now = new Date();

        if (clock) {
            clock.textContent = new Intl.DateTimeFormat("en-IN", {
                timeZone: IST_TIME_ZONE,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: true
            }).format(now);
        }

        if (date) {
            date.textContent = new Intl.DateTimeFormat("en-IN", {
                timeZone: IST_TIME_ZONE,
                day: "numeric",
                month: "long",
                year: "numeric"
            }).format(now);
        }
    }

    updateClock();
    setInterval(updateClock, 1000);

    // -------------------------------
    // DATABASE SAVE AND LOAD
    // -------------------------------

    function saveReminders() {

        localStorage.setItem(storageKey, JSON.stringify(reminders));

        const savedData = JSON.stringify(reminders);

        saveQueue = saveQueue.then(async function () {

            const response = await fetch("/api/reminders", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    reminders: JSON.parse(savedData)
                })
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(
                    result.error || "Could not save reminders."
                );
            }

            return result;

        }).catch(function (error) {

            console.error("Reminder database save failed:", error);

            alert(
                "Reminder could not be saved to the database. " +
                "Your browser backup has been preserved."
            );
        });

        return saveQueue;
    }

    async function loadRemindersFromDatabase() {

        try {

            const response = await fetch("/api/reminders");

            if (!response.ok) {
                throw new Error("Could not load reminders from database.");
            }

            const databaseReminders = await response.json();

            if (!Array.isArray(databaseReminders)) {
                throw new Error("Invalid reminder data received.");
            }

            if (databaseReminders.length > 0) {

                reminders = databaseReminders.map(item => ({
                    ...item,
                    id: String(item.id),
                    medicine: item.medicine || item.name || ""
                }));

            } else {

                const usedIds = new Set();

                reminders = reminders.map((item, index) => {

                    let id = String(
                        item.id || `legacy-${Date.now()}-${index}`
                    );

                    if (usedIds.has(id)) {
                        id = `legacy-${Date.now()}-${index}-${usedIds.size}`;
                    }

                    usedIds.add(id);

                    return {
                        ...item,
                        id: id,
                        medicine: item.medicine || item.name || ""
                    };
                });

                if (reminders.length > 0) {

                    await saveReminders();

                    const verifyResponse = await fetch("/api/reminders");

                    if (!verifyResponse.ok) {
                        throw new Error("Could not verify reminder migration.");
                    }

                    const verifiedReminders = await verifyResponse.json();

                    if (verifiedReminders.length !== reminders.length) {
                        throw new Error("Reminder migration could not be verified.");
                    }
                }
            }

            localStorage.setItem(
                storageKey,
                JSON.stringify(reminders)
            );

            console.log("Reminders loaded successfully.");

            return true;

        } catch (error) {

            console.error("Reminder loading failed:", error);

            alert(
                "Could not load reminders from the database. " +
                "Your browser backup has been preserved."
            );

            return false;
        }
    }

    // -------------------------------
    // REPEAT REMINDER CHECK
    // -------------------------------

    function isReminderDue(reminder, today) {

        if (!reminder.date) return false;

        if (reminder.repeat === "once") {
            return reminder.date === today;
        }

        const startDate = new Date(reminder.date + "T00:00:00");
        const currentDate = new Date(today + "T00:00:00");

        if (currentDate < startDate) {
            return false;
        }

        if (reminder.repeat === "daily") {
            return true;
        }

        if (reminder.repeat === "weekly") {
            return startDate.getDay() === currentDate.getDay();
        }

        if (reminder.repeat === "monthly") {
            return startDate.getDate() === currentDate.getDate();
        }

        return reminder.date === today;
    }

    // -------------------------------
    // ALARM SOUND
    // -------------------------------

    function playAlarmSound() {

        try {

            const AudioContext =
                window.AudioContext || window.webkitAudioContext;

            if (!AudioContext) return;

            if (!alarmAudioContext) {
                alarmAudioContext = new AudioContext();
            }

            if (alarmAudioContext.state === "suspended") {
                alarmAudioContext.resume();
            }

            const oscillator = alarmAudioContext.createOscillator();
            const gain = alarmAudioContext.createGain();

            oscillator.connect(gain);
            gain.connect(alarmAudioContext.destination);

            oscillator.type = "sine";
            oscillator.frequency.value = 880;

            gain.gain.setValueAtTime(
                0.2,
                alarmAudioContext.currentTime
            );

            oscillator.start();

            gain.gain.setValueAtTime(
                0,
                alarmAudioContext.currentTime + 0.5
            );

            oscillator.stop(alarmAudioContext.currentTime + 0.5);

        } catch (error) {
            console.error("Alarm sound error:", error);
        }
    }

    // -------------------------------
    // SPEAK MEDICINE NAME
    // -------------------------------

    function speakMedicineName(medicine) {

        if (!("speechSynthesis" in window)) {
            console.error("Speech is not supported in this browser.");
            return;
        }

        window.speechSynthesis.cancel();

        const medicineName = String(medicine || "your medicine")
            .replace(/[<>]/g, "");

        const message = new SpeechSynthesisUtterance(
            "Time to take " + medicineName
        );

        message.lang = "en-IN";
        message.rate = 0.9;
        message.pitch = 1;

        window.speechSynthesis.speak(message);
    }

    // -------------------------------
    // STOP ALARM
    // -------------------------------

    function stopAlarm() {

        if (activeAlarmId) {
            clearInterval(activeAlarmId);
            activeAlarmId = null;
        }

        if (alarmTimeoutId) {
            clearTimeout(alarmTimeoutId);
            alarmTimeoutId = null;
        }

        if ("speechSynthesis" in window) {
            window.speechSynthesis.cancel();
        }

        const popup = document.getElementById("alarmPopup");

        if (popup) {
            popup.remove();
        }
    }

    // -------------------------------
    // SHOW ALARM
    // -------------------------------

    function showAlarm(reminder) {

        if (document.getElementById("alarmPopup")) return;

        const popup = document.createElement("div");

        popup.id = "alarmPopup";

        popup.style.position = "fixed";
        popup.style.inset = "0";
        popup.style.background = "rgba(0,0,0,0.65)";
        popup.style.display = "flex";
        popup.style.alignItems = "center";
        popup.style.justifyContent = "center";
        popup.style.zIndex = "99999";

        popup.innerHTML = `
            <div style="
                background:white;
                color:#333;
                padding:30px;
                border-radius:16px;
                text-align:center;
                width:85%;
                max-width:350px;
                box-shadow:0 5px 25px rgba(0,0,0,0.3);
            ">
                <h2 style="color:#7040b5;">Reminder Time!</h2>

                <h3>${escapeHTML(reminder.medicine || "Medicine")}</h3>

                <p>Time to take ${escapeHTML(reminder.medicine || "your medicine")}.</p>

                <button id="stopAlarmButton" style="
                    background:#7040b5;
                    color:white;
                    border:none;
                    padding:12px 30px;
                    border-radius:8px;
                    cursor:pointer;
                    font-weight:bold;
                ">OK</button>
            </div>
        `;

        document.body.appendChild(popup);

        document.getElementById("stopAlarmButton")
            .addEventListener("click", stopAlarm);

        activeAlarmId = setInterval(playAlarmSound, 1500);

        playAlarmSound();

        speakMedicineName(reminder.medicine);

        alarmTimeoutId = setTimeout(stopAlarm, 60000);
    }

    // -------------------------------
    // CHECK ALARMS
    // -------------------------------

    function checkAlarms() {

        const today = getTodayIST();
        const parts = getISTParts();
        const currentTime = `${parts.hour}:${parts.minute}`;

        reminders.forEach(reminder => {

            if (reminder.completed) return;

            if (!isReminderDue(reminder, today)) return;

            if (reminder.time !== currentTime) return;

            if (reminder.lastAlarmDate === today) return;

            reminder.lastAlarmDate = today;

            saveReminders();

            showAlarm(reminder);
        });
    }

    // -------------------------------
    // ENABLE ALARM SOUND BUTTON
    // -------------------------------

    const reminderForm = document.getElementById("reminderForm");

    if (reminderForm &&
        !document.getElementById("enableAlarmButton")) {

        const alarmButton = document.createElement("button");

        alarmButton.type = "button";
        alarmButton.id = "enableAlarmButton";
        alarmButton.textContent = "Enable Alarm Sound";

        alarmButton.style.marginBottom = "12px";
        alarmButton.style.padding = "10px 16px";
        alarmButton.style.border = "none";
        alarmButton.style.borderRadius = "8px";
        alarmButton.style.background = "#7040b5";
        alarmButton.style.color = "white";
        alarmButton.style.cursor = "pointer";

        reminderForm.parentNode.insertBefore(
            alarmButton,
            reminderForm
        );

        alarmButton.addEventListener("click", async function () {

            const AudioContext =
                window.AudioContext || window.webkitAudioContext;

            if (!AudioContext) {
                alert("Alarm sound is not supported in this browser.");
                return;
            }

            if (!alarmAudioContext) {
                alarmAudioContext = new AudioContext();
            }

            if (alarmAudioContext.state === "suspended") {
                await alarmAudioContext.resume();
            }

            playAlarmSound();

            if ("speechSynthesis" in window) {
                speakMedicineName("test medicine");
            }

            alarmButton.textContent = "Alarm Sound Enabled";
        });
    }

    // -------------------------------
    // THEME TOGGLE
    // -------------------------------

    const themeButton = document.getElementById("themeToggle");

    const savedTheme = localStorage.getItem(
        "tabletTheme_" + username
    );

    if (savedTheme === "dark") {
        document.body.classList.add("dark-mode");
    }

    if (themeButton) {

        themeButton.addEventListener("click", function () {

            document.body.classList.toggle("dark-mode");

            const isDark = document.body.classList.contains("dark-mode");

            localStorage.setItem(
                "tabletTheme_" + username,
                isDark ? "dark" : "light"
            );
        });
    }

    // -------------------------------
    // STOCK API
    // -------------------------------

    
async function loadStock() {
    try {
        const response = await fetch("/api/stock");

        if (!response.ok) {
            throw new Error("Could not load stock.");
        }

        stockItems = await response.json();
        renderStock();

        await loadStockHistory();

    } catch (error) {
        console.error("Stock loading error:", error);
    }
}

async function loadStockHistory() {
    try {
        const response = await fetch("/api/stock-history");

        if (!response.ok) {
            throw new Error("Could not load medicine history.");
        }

        const history = await response.json();

        let section = document.getElementById("stockHistorySection");

        if (!section) {
            section = document.createElement("section");
            section.id = "stockHistorySection";
            section.style.marginTop = "20px";
            section.style.padding = "15px";
            section.style.borderRadius = "10px";
            section.style.background = "rgba(120,100,180,0.08)";

            const stockList = document.getElementById("stockList");

            if (!stockList) return;

            stockList.insertAdjacentElement("afterend", section);
        }

        section.innerHTML = `
            <h3>Medicine Refill History</h3>
            <div id="stockHistoryList"></div>
        `;

        const historyList = section.querySelector("#stockHistoryList");

        if (!history.length) {
            historyList.innerHTML = "<p>No medicine history yet.</p>";
            return;
        }

        historyList.innerHTML = history.map(item => `
            <div style="
                padding:12px;
                margin-bottom:10px;
                border-radius:8px;
                background:rgba(120,100,180,0.12);
            ">
                <strong>${escapeHTML(item.medicine_name)}</strong>
                <p>Action: ${escapeHTML(item.action)}</p>
                <p>Quantity: ${Number(item.quantity)}</p>
                <p>Date: ${escapeHTML(item.activity_date)}</p>
            </div>
        `).join("");

    } catch (error) {
        console.error("Medicine history error:", error);
    }
}


    // -------------------------------
    // EXPIRY ALERTS
    // -------------------------------

    function checkExpiryAlerts(item) {

        const expiryInfo = getExpiryStatus(item.expiry_date);

        if (!expiryInfo || expiryInfo.status === "Valid") {
            return;
        }

        const alertKey = `expiryAlert_${username}_${item.id}`;
        const previousAlert = localStorage.getItem(alertKey);

        if (previousAlert === expiryInfo.status) {
            return;
        }

        const medicineName = item.medicine_name || "Your medicine";

        let message = "";

        if (expiryInfo.status === "Expired") {

            message =
                `${medicineName} has expired. Please do not use it. ` +
                "Check with a pharmacist about safe disposal and replacement.";

        } else if (expiryInfo.status === "Expires Today") {

            message =
                `${medicineName} expires today. Please check the expiry date ` +
                "and ask a pharmacist before using it.";

        } else {

            message =
                `${medicineName} is expiring in ${expiryInfo.daysLeft} days. ` +
                "Please check the expiry date and plan ahead.";
        }

        localStorage.setItem(alertKey, expiryInfo.status);

        alert(message);

        if ("speechSynthesis" in window) {

            window.speechSynthesis.cancel();

            const speech = new SpeechSynthesisUtterance(message);

            speech.lang = "en-IN";
            speech.rate = 0.9;

            window.speechSynthesis.speak(speech);
        }
    }

    // -------------------------------
    // RENDER STOCK
    // -------------------------------

    function renderStock() {

        const stockList = document.getElementById("stockList");

        if (!stockList) return;

        if (!stockItems.length) {
            stockList.innerHTML = "<p>No tablet stock added yet.</p>";
            return;
        }

        // Stock voice alerts and expiry alerts
        stockItems.forEach(item => {

            const quantity = Number(item.quantity);
            const medicineName = String(
                item.medicine_name || "Unknown tablet"
            );

            const alertKey = `stockVoiceAlert_${username}_${item.id}`;
            const previousAlert = localStorage.getItem(alertKey);

            let message = "";

            if (quantity === 5) {
                message = `${medicineName}. Only 5 tablets are left. Please buy more.`;
            } else if (quantity === 1) {
                message = `${medicineName}. Only 1 tablet is left. Please buy more.`;
            } else if (quantity === 0) {
                message = `${medicineName}. Your tablet stock is empty. Please restock.`;
            }

            if (message && previousAlert !== String(quantity)) {

                if ("speechSynthesis" in window) {
                    const speech = new SpeechSynthesisUtterance(message);
                    speech.lang = "en-IN";
                    speech.rate = 0.9;
                    window.speechSynthesis.speak(speech);
                }

                alert(message);

                localStorage.setItem(alertKey, String(quantity));
            }

            if (quantity > 5) {
                localStorage.removeItem(alertKey);
            }

            // Check medicine expiry
            checkExpiryAlerts(item);
        });

        // Display tablet stock
        stockList.innerHTML = stockItems.map(item => {

            let status = "In Stock";
            let statusColor = "#279b65";
            let stockAlert = "";

            if (item.quantity <= 0) {

                status = "Out of Stock";
                statusColor = "#d93025";
                stockAlert = "Your tablet stock is empty. Please restock it.";

            } else if (item.quantity === 1) {

                status = "Very Low Stock";
                statusColor = "#d93025";
                stockAlert = "Only 1 tablet is left. Please arrange to buy more tablets.";

            } else if (item.quantity <= 5) {

                status = "Low Stock";
                statusColor = "#e69a00";
                stockAlert = `Your tablets are down to ${item.quantity}. Please buy more tablets soon.`;
            }

            const expiryInfo = getExpiryStatus(item.expiry_date);

            let expiryHTML = "";

            if (item.expiry_date) {

                const expiryColor = expiryInfo
                    ? expiryInfo.color
                    : "#666";

                const expiryStatus = expiryInfo
                    ? expiryInfo.status
                    : "Date unavailable";

                expiryHTML = `
                    <p>
                        Expiry Date:
                        <strong>${escapeHTML(formatExpiryDate(item.expiry_date))}</strong>
                    </p>

                    <p style="
                        color:${expiryColor};
                        font-weight:bold;
                    ">
                        ${escapeHTML(expiryStatus)}
                    </p>
                `;

            } else {

                expiryHTML = `
                    <p style="color:#e69a00;">
                        Expiry date not provided.
                    </p>
                `;
            }

            return `
                <div class="stock-item" style="
                    padding:12px;
                    margin-bottom:12px;
                    border-radius:10px;
                    background:rgba(120,100,180,0.08);
                ">

                    <strong>${escapeHTML(item.medicine_name)}</strong>

                    <p>Quantity: ${item.quantity}</p>

                    <p style="
                        color:${statusColor};
                        font-weight:bold;
                    ">
                        ${status}
                    </p>

                    ${stockAlert ? `
                        <p role="alert" style="
                            color:${statusColor};
                            font-weight:bold;
                            background:rgba(217,48,37,0.08);
                            padding:10px;
                            border-radius:8px;
                            margin:8px 0;
                        ">${escapeHTML(stockAlert)}</p>
                    ` : ""}

                    ${expiryHTML}

                    <button onclick="restockTablet(${item.id})">
                        Restock
                    </button>

                    <button onclick="deleteTablet(${item.id})">
                        Delete
                    </button>

                </div>
            `;

        }).join("");
    }

    // -------------------------------
    // ADD STOCK
    // -------------------------------

    const stockForm = document.getElementById("stockForm");

    if (stockForm) {

        stockForm.addEventListener("submit", async function (event) {

            event.preventDefault();

            const medicineInput =
                document.getElementById("stockMedicineName");

            const quantityInput =
                document.getElementById("stockQuantity");

            const expiryInput =
                document.getElementById("stockExpiryDate");

            if (!medicineInput || !quantityInput || !expiryInput) return;

            const medicine_name = medicineInput.value.trim();
            const quantity = Number(quantityInput.value);
            const expiry_date = expiryInput.value;

            if (!medicine_name ||
                !Number.isInteger(quantity) ||
                quantity <= 0 ||
                !expiry_date) {

                alert("Please enter a medicine name, valid quantity, and expiry date.");
                return;
            }

            if (expiry_date < getTodayIST()) {
                alert("Please enter a future expiry date.");
                return;
            }

            try {

                const response = await fetch("/api/stock", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        medicine_name: medicine_name,
                        quantity: quantity,
                        expiry_date: expiry_date
                    })
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.error || "Could not add stock.");
                }

                stockForm.reset();

                await loadStock();

            } catch (error) {
                alert(error.message);
            }
        });
    }

    // -------------------------------
    // RESTOCK TABLET
    // -------------------------------

    window.restockTablet = async function (id) {

        const amount = prompt("How many tablets do you want to add?");

        if (amount === null) return;

        const quantity = Number(amount);

        if (!Number.isInteger(quantity) || quantity <= 0) {
            alert("Enter a valid positive quantity.");
            return;
        }

        try {

            const response = await fetch(
                `/api/stock/${id}/restock`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        quantity: quantity
                    })
                }
            );

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || "Restock failed.");
            }

            await loadStock();

        } catch (error) {
            alert(error.message);
        }
    };

    // -------------------------------
    // DELETE STOCK
    // -------------------------------

    window.deleteTablet = async function (id) {

        if (!confirm("Are you sure you want to delete this stock item?")) {
            return;
        }

        try {

            const response = await fetch(`/api/stock/${id}`, {
                method: "DELETE"
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || "Delete failed.");
            }

            localStorage.removeItem(`stockVoiceAlert_${username}_${id}`);
            localStorage.removeItem(`expiryAlert_${username}_${id}`);

            await loadStock();

        } catch (error) {
            alert(error.message);
        }
    };

    // -------------------------------
    // DEDUCT STOCK ON COMPLETE
    // -------------------------------

    async function deductStockForReminder(reminder) {

        if (!reminder.medicine || reminder.stockDeducted) {
            return;
        }

        const stockItem = stockItems.find(item =>
            item.medicine_name.toLowerCase() ===
            reminder.medicine.toLowerCase()
        );

        if (!stockItem) return;

        if (stockItem.quantity <= 0) {
            alert("This medicine is marked Out of Stock.");
            return;
        }

        const response = await fetch(
            `/api/stock/${stockItem.id}/use`,
            {
                method: "POST"
            }
        );

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Could not update stock.");
        }

        reminder.stockDeducted = true;

        await loadStock();
    }

    // -------------------------------
    // RESTORE STOCK ON UNDO
    // -------------------------------

    async function restoreStockForReminder(reminder) {

        if (!reminder.medicine || !reminder.stockDeducted) {
            return;
        }

        const stockItem = stockItems.find(item =>
            item.medicine_name.toLowerCase() ===
            reminder.medicine.toLowerCase()
        );

        if (!stockItem) return;

        const response = await fetch(
            `/api/stock/${stockItem.id}/restock`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    quantity: 1
                })
            }
        );

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Could not restore stock.");
        }

        reminder.stockDeducted = false;

        await loadStock();
    }

    // -------------------------------
    // HISTORY
    // -------------------------------

    function renderHistory() {

        const historyList = document.getElementById("historyList");

        if (!historyList) return;

        const completed = reminders
            .filter(item => item.completed)
            .sort((a, b) =>
                new Date(b.completedAt || 0) -
                new Date(a.completedAt || 0)
            );

        if (!completed.length) {
            historyList.innerHTML = "<p>No completed reminders yet.</p>";
            return;
        }

        historyList.innerHTML = completed.map(item => `
            <div class="history-item">
                <strong>${escapeHTML(item.medicine || "Medicine")}</strong>
                <span>${escapeHTML(item.date || "")}</span>
                <span>${escapeHTML(item.time || "")}</span>
                <span>Completed</span>
            </div>
        `).join("");
    }

    // -------------------------------
    // HTML ESCAPE
    // -------------------------------

    function escapeHTML(value) {

        return String(value ?? "").replace(/[&<>"']/g, function (char) {

            const entities = {
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#039;"
            };

            return entities[char];
        });
    }

    // -------------------------------
    // EDIT REMINDER FORM
    // -------------------------------

    function createEditForm(reminder, container) {

        container.innerHTML = `
            <div class="edit-reminder-form">

                <input
                    type="text"
                    class="edit-medicine"
                    value="${escapeHTML(reminder.medicine)}"
                    placeholder="Medicine name"
                >

                <input
                    type="date"
                    class="edit-date"
                    value="${escapeHTML(reminder.date)}"
                >

                <input
                    type="time"
                    class="edit-time"
                    value="${escapeHTML(reminder.time)}"
                >

                <select class="edit-repeat">
                    <option value="once">Once</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                </select>

                <div class="reminder-actions">

                    <button class="save-btn" type="button">
                        Save
                    </button>

                    <button class="cancel-btn" type="button">
                        Cancel
                    </button>

                </div>
            </div>
        `;

        const repeatSelect = container.querySelector(".edit-repeat");

        repeatSelect.value = reminder.repeat || "once";

        container.querySelector(".save-btn")
            .addEventListener("click", async function () {

                const medicine = container.querySelector(".edit-medicine")
                    .value.trim();

                const date = container.querySelector(".edit-date").value;
                const time = container.querySelector(".edit-time").value;
                const repeat = repeatSelect.value;

                if (!medicine || !date || !time) {
                    alert("Please fill in all reminder details.");
                    return;
                }

                reminder.medicine = medicine;
                reminder.date = date;
                reminder.time = time;
                reminder.repeat = repeat;

                reminder.lastAlarmDate = null;

                await saveReminders();

                renderReminders();
                renderCalendar();
                updateStats();
            });

        container.querySelector(".cancel-btn")
            .addEventListener("click", renderReminders);
    }

    // -------------------------------
    // STATISTICS
    // -------------------------------

    function updateStats() {

        const totalElement = document.getElementById("totalReminders");
        const completedElement = document.getElementById("completedReminders");
        const pendingElement = document.getElementById("upcomingReminders");

        const total = reminders.length;
        const completed = reminders.filter(item => item.completed).length;
        const pending = total - completed;

        if (totalElement) totalElement.textContent = total;
        if (completedElement) completedElement.textContent = completed;
        if (pendingElement) pendingElement.textContent = pending;
    }

    // -------------------------------
    // SEARCH AND FILTER
    // -------------------------------

    const searchInput = document.getElementById("searchReminder");
    const filterSelect = document.getElementById("filterReminder");

    if (searchInput) {
        searchInput.addEventListener("input", function () {
            remindersVisible = 3;
            renderReminders();
        });
    }

    if (filterSelect) {
        filterSelect.addEventListener("change", function () {
            remindersVisible = 3;
            renderReminders();
        });
    }

    // -------------------------------
    // RENDER REMINDERS
    // -------------------------------

    function renderReminders() {

        const reminderList = document.getElementById("reminderList");

        if (!reminderList) return;

        const searchText = searchInput
            ? searchInput.value.toLowerCase().trim()
            : "";

        const filter = filterSelect
            ? filterSelect.value
            : "all";

        const filteredReminders = reminders.filter(reminder => {

            const matchesSearch =
                (reminder.medicine || "")
                    .toLowerCase()
                    .includes(searchText);

            let matchesFilter = true;

            if (filter === "completed") {
                matchesFilter = reminder.completed;
            } else if (filter === "pending") {
                matchesFilter = !reminder.completed;
            }

            return matchesSearch && matchesFilter;
        });

        if (!filteredReminders.length) {

            reminderList.innerHTML = reminders.length
                ? "<p>No matching reminders found.</p>"
                : "<p>No reminders added yet.</p>";

            return;
        }

        const visibleReminders = filteredReminders.slice(
            0,
            remindersVisible
        );

        reminderList.innerHTML = visibleReminders.map(reminder => {

            return `
                <div class="reminder-card"
                     data-id="${escapeHTML(reminder.id)}">

                    <div class="reminder-info">

                        <h3>${escapeHTML(reminder.medicine || "Medicine")}</h3>

                        <p>Date: ${escapeHTML(reminder.date || "")}</p>

                        <p>Time: ${escapeHTML(reminder.time || "")}</p>

                        <p>Repeat: ${escapeHTML(reminder.repeat || "once")}</p>

                        <p>
                            Status:
                            <strong>
                                ${reminder.completed ? "Completed" : "Pending"}
                            </strong>
                        </p>

                    </div>

                    <div class="reminder-actions">

                        ${
                            reminder.completed
                            ? `<button class="undo-btn" data-id="${escapeHTML(reminder.id)}">Undo</button>`
                            : `<button class="complete-btn" data-id="${escapeHTML(reminder.id)}">Complete</button>`
                        }

                        <button class="edit-btn" data-id="${escapeHTML(reminder.id)}">
                            Edit
                        </button>

                        <button class="delete-btn" data-id="${escapeHTML(reminder.id)}">
                            Delete
                        </button>

                    </div>

                </div>
            `;

        }).join("");

        // LOAD MORE BUTTON
        if (filteredReminders.length > remindersVisible) {

            const loadMoreButton = document.createElement("button");

            loadMoreButton.textContent = "Load More";
            loadMoreButton.type = "button";
            loadMoreButton.className = "load-more-btn";

            loadMoreButton.style.display = "block";
            loadMoreButton.style.margin = "20px auto";
            loadMoreButton.style.padding = "10px 25px";
            loadMoreButton.style.background = "#7040b5";
            loadMoreButton.style.color = "white";
            loadMoreButton.style.border = "none";
            loadMoreButton.style.borderRadius = "8px";
            loadMoreButton.style.cursor = "pointer";

            loadMoreButton.addEventListener("click", function () {

                remindersVisible += 5;
                renderReminders();

            });

            reminderList.appendChild(loadMoreButton);
        }

        // SHOW LESS BUTTON
        if (remindersVisible > 3) {

            const showLessButton = document.createElement("button");

            showLessButton.textContent = "Show Less";
            showLessButton.type = "button";
            showLessButton.className = "show-less-btn";

            showLessButton.style.display = "block";
            showLessButton.style.margin = "10px auto 20px";
            showLessButton.style.padding = "10px 25px";
            showLessButton.style.background = "#999";
            showLessButton.style.color = "white";
            showLessButton.style.border = "none";
            showLessButton.style.borderRadius = "8px";
            showLessButton.style.cursor = "pointer";

            showLessButton.addEventListener("click", function () {

                remindersVisible = 3;
                renderReminders();

            });

            reminderList.appendChild(showLessButton);
        }

        // COMPLETE REMINDER
        reminderList.querySelectorAll(".complete-btn")
            .forEach(button => {

                button.addEventListener("click", async function () {

                    const reminder = reminders.find(item =>
                        String(item.id) === button.dataset.id
                    );

                    if (!reminder) return;

                    try {

                        await deductStockForReminder(reminder);

                        reminder.completed = true;
                        reminder.completedAt = new Date().toISOString();

                        await saveReminders();

                        renderReminders();
                        renderCalendar();
                        updateStats();
                        renderHistory();

                    } catch (error) {
                        alert(error.message);
                    }
                });
            });

        // UNDO COMPLETION
        reminderList.querySelectorAll(".undo-btn")
            .forEach(button => {

                button.addEventListener("click", async function () {

                    const reminder = reminders.find(item =>
                        String(item.id) === button.dataset.id
                    );

                    if (!reminder) return;

                    try {

                        await restoreStockForReminder(reminder);

                        reminder.completed = false;
                        delete reminder.completedAt;

                        await saveReminders();

                        renderReminders();
                        renderCalendar();
                        updateStats();
                        renderHistory();

                    } catch (error) {
                        alert(error.message);
                    }
                });
            });

        // EDIT REMINDER
        reminderList.querySelectorAll(".edit-btn")
            .forEach(button => {

                button.addEventListener("click", function () {

                    const reminder = reminders.find(item =>
                        String(item.id) === button.dataset.id
                    );

                    if (!reminder) return;

                    const card = button.closest(".reminder-card");

                    createEditForm(reminder, card);
                });
            });

        // DELETE REMINDER
        reminderList.querySelectorAll(".delete-btn")
            .forEach(button => {

                button.addEventListener("click", function () {

                    if (!confirm("Delete this reminder?")) return;

                    reminders = reminders.filter(item =>
                        String(item.id) !== button.dataset.id
                    );

                    saveReminders();

                    renderReminders();
                    renderCalendar();
                    updateStats();
                    renderHistory();
                });
            });
    }

    // -------------------------------
    // ADD REMINDER
    // -------------------------------

    if (reminderForm) {

        reminderForm.addEventListener("submit", function (event) {

            event.preventDefault();

            const medicineInput = document.getElementById("medicine");
            const dateInput = document.getElementById("date");
            const timeInput = document.getElementById("time");
            const repeatInput = document.getElementById("repeat");

            if (!medicineInput || !dateInput || !timeInput) return;

            const medicine = medicineInput.value.trim();
            const date = dateInput.value;
            const time = timeInput.value;
            const repeat = repeatInput ? repeatInput.value : "once";

            if (!medicine || !date || !time) {
                alert("Please fill in all reminder details.");
                return;
            }

            const newReminder = {
                id: Date.now().toString(),
                medicine: medicine,
                date: date,
                time: time,
                repeat: repeat,
                completed: false,
                stockDeducted: false,
                lastAlarmDate: null
            };

            reminders.push(newReminder);

            remindersVisible = Math.max(remindersVisible, reminders.length);

            saveReminders();

            reminderForm.reset();

            dateInput.value = getTodayDate();

            renderReminders();
            renderCalendar();
            updateStats();
            renderHistory();
        });
    }

    // -------------------------------
    // CALENDAR
    // -------------------------------

    function renderCalendar() {

        const calendar = document.getElementById("calendarReminders");
        const dateInput = document.getElementById("calendarDate");

        if (!calendar || !dateInput) return;

        const selectedDate = dateInput.value || getTodayIST();

        const selectedReminders = reminders.filter(reminder =>
            isReminderDue(reminder, selectedDate)
        );

        if (!selectedReminders.length) {
            calendar.innerHTML = "<p>No reminders for this date.</p>";
            return;
        }

        calendar.innerHTML = selectedReminders.map(reminder => `
            <div class="calendar-item">
                <strong>${escapeHTML(reminder.medicine || "Medicine")}</strong>
                <span>${escapeHTML(reminder.time || "")}</span>
                <span>${reminder.completed ? "Completed" : "Pending"}</span>
            </div>
        `).join("");
    }

    // -------------------------------
    // CALENDAR DATE CHANGE
    // -------------------------------

    const calendarDateInput = document.getElementById("calendarDate");

    if (calendarDateInput) {

        calendarDateInput.addEventListener("change", function () {
            renderCalendar();
        });
    }

    // -------------------------------
    // DASHBOARD INITIALIZATION
    // -------------------------------

    async function initializeDashboard() {

        const dateInput = document.getElementById("date");

        if (dateInput && !dateInput.value) {
            dateInput.value = getTodayDate();
        }

        const calendarInput = document.getElementById("calendarDate");

        if (calendarInput && !calendarInput.value) {
            calendarInput.value = getTodayIST();
        }

        const loaded = await loadRemindersFromDatabase();

        if (!loaded) {
            return;
        }

        await loadStock();

        renderReminders();
        renderCalendar();
        updateStats();
        renderHistory();

        setInterval(checkAlarms, 1000);
    }

    initializeDashboard();

    // -------------------------------
    // REFRESH STOCK WHEN RETURNING
    // -------------------------------

    document.addEventListener("visibilitychange", function () {

        if (!document.hidden) {

            renderReminders();
            renderCalendar();
            updateStats();
            renderHistory();

            checkAlarms();
            loadStock();
        }
    });

});
