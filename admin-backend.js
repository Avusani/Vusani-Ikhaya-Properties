(function () {
  window.liveAdminBackendReady = true;
  window.liveAdminBackendConnected = false;

  const TOKEN_KEY = "alexandra-admin-token";
  const SESSION_KEY = "adminSession"; // Added missing constant
  const ADMIN_PASSWORD = "Av98012@12"; // Your admin password
  const APPROVED_KEY = "alexandra-room-approved";
  const TAKEN_KEY = "alexandra-room-taken";

  const viewMap = {
    pending: ["rooms", "pending"],
    approved: ["rooms", "approved"],
    taken: ["rooms", "taken"],
    declined: ["rooms", "declined"],
    removed: ["rooms", "removed"],
    "review-pending": ["reviews", "pending"],
    "review-approved": ["reviews", "approved"],
    "review-declined": ["reviews", "declined"],
    "report-pending": ["reports", "pending"],
    "report-approved": ["reports", "approved"],
    "report-declined": ["reports", "declined"],
    "transport-pending": ["transports", "pending"],
    "transport-approved": ["transports", "approved"],
    "transport-declined": ["transports", "declined"],
    "transport-removed": ["transports", "removed"]
  };

  const storageMap = {
    "alexandra-room-pending": ["rooms", "pending"],
    "alexandra-room-approved": ["rooms", "approved"],
    "alexandra-room-taken": ["rooms", "taken"],
    "alexandra-room-declined": ["rooms", "declined"],
    "alexandra-room-removed": ["rooms", "removed"],
    "alexandra-review-pending": ["reviews", "pending"],
    "alexandra-review-approved": ["reviews", "approved"],
    "alexandra-review-declined": ["reviews", "declined"],
    "alexandra-report-pending": ["reports", "pending"],
    "alexandra-report-approved": ["reports", "approved"],
    "alexandra-report-declined": ["reports", "declined"],
    "alexandra-transport-pending": ["transports", "pending"],
    "alexandra-transport-approved": ["transports", "approved"],
    "alexandra-transport-declined": ["transports", "declined"],
    "alexandra-transport-removed": ["transports", "removed"]
  };

  const emptyDB = {
    rooms: { pending: [], approved: [], taken: [], declined: [], removed: [] },
    reviews: { pending: [], approved: [], declined: [] },
    reports: { pending: [], approved: [], declined: [] },
    transports: { pending: [], approved: [], declined: [], removed: [] },
    receipts: []
  };

  let liveDB = null;
  const storedGetList = window.getList;

  // Service fee calculation based on rent amount
  function serviceFeeForRent(rentAmount) {
    const rent = parseFloat(String(rentAmount).replace(/[^0-9.]/g, '')) || 0;
    if (rent >= 1000 && rent <= 1900) return 300;
    if (rent >= 2000 && rent <= 3000) return 350;
    if (rent >= 3100 && rent <= 3800) return 400;
    if (rent >= 3900 && rent <= 7000) return 500;
    return 0;
  }

  function moneyNumber(value) {
    if (!value) return '';
    const num = parseFloat(String(value).replace(/[^0-9.]/g, ''));
    return isNaN(num) ? '' : num;
  }

  function cleanSection(section, fallback) {
    const source = section && typeof section === "object" ? section : {};
    return Object.fromEntries(
      Object.keys(fallback).map((status) => [
        status,
        Array.isArray(source[status]) ? source[status] : []
      ])
    );
  }

  function normalizeClientDB(db) {
    return {
      rooms: cleanSection(db?.rooms, emptyDB.rooms),
      reviews: cleanSection(db?.reviews, emptyDB.reviews),
      reports: cleanSection(db?.reports, emptyDB.reports),
      transports: cleanSection(db?.transports, emptyDB.transports),
      receipts: Array.isArray(db?.receipts) ? db.receipts : []
    };
  }

  window.getList = function (key) {
    if (liveDB && storageMap[key]) {
      const [section, status] = storageMap[key];
      return liveDB[section]?.[status] || [];
    }
    if (liveDB && key === "alexandra-receipts") return liveDB.receipts || [];
    return typeof storedGetList === "function" ? storedGetList(key) : [];
  };

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }

  async function loginWithPassword(password) {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) throw new Error(data.error || "Incorrect admin password.");
    sessionStorage.setItem(TOKEN_KEY, data.token);
    sessionStorage.setItem(SESSION_KEY, "yes");
    return data.token;
  }

  async function api(path, options = {}, retryOnLogin = true) {
    const response = await fetch(path, {
      headers: {
        "Content-Type": "application/json",
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
        ...(options.headers || {})
      },
      ...options
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      const message = data.error || "Request failed";
      if (response.status === 401 && retryOnLogin && path !== "/api/admin/login") {
        await loginWithPassword(ADMIN_PASSWORD);
        return api(path, options, false);
      }
      throw new Error(message);
    }
    return data;
  }

  function syncLocalStorage(db) {
    Object.entries(storageMap).forEach(([key, [section, status]]) => {
      try {
        localStorage.setItem(key, JSON.stringify(db[section][status] || []));
      } catch {
        localStorage.removeItem(key);
      }
    });
    try {
      localStorage.setItem("alexandra-receipts", JSON.stringify(db.receipts || []));
    } catch {
      localStorage.removeItem("alexandra-receipts");
    }
  }

  async function refreshAdmin() {
    try {
      const db = normalizeClientDB(await api("/api/admin/data"));
      liveDB = db;
      window.adminLiveDB = db;
      window.liveAdminBackendConnected = true;
      syncLocalStorage(db);
      
      // Call render functions if they exist
      if (typeof renderRooms === "function") renderRooms();
      if (typeof renderTransportTab === "function") renderTransportTab(currentTransportTab || 'pending');
      if (typeof renderMonthlyReport === "function") renderMonthlyReport();
      if (typeof updateAllCounts === "function") updateAllCounts();
      if (typeof updateStats === "function") updateStats();
      if (typeof renderChart === "function") renderChart();
      
    } catch (error) {
      window.liveAdminBackendConnected = false;
      console.error('Refresh admin failed:', error);
      throw error;
    }
  }

  window.refreshAdminData = refreshAdmin;

  async function adminAction(payload, message) {
    try {
      await api("/api/admin/action", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await refreshAdmin();
      if (message && typeof showNotice === "function") showNotice(message);
    } catch (error) {
      window.liveAdminBackendConnected = false;
      const messageText = error.message || "Admin action failed. Refresh and try again.";
      if (typeof showNotice === "function") showNotice(messageText);
      if (/admin login required/i.test(messageText)) {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(SESSION_KEY);
        if (typeof renderAuth === "function") renderAuth();
      }
    }
  }

  // ========================================
  // SHOW NOTICE
  // ========================================
  function showNotice(message) {
    const notice = document.getElementById('notice');
    if (notice) {
      notice.textContent = message;
      notice.className = 'notice show success';
      setTimeout(() => {
        notice.classList.remove('show');
      }, 4000);
    }
  }

  // ========================================
  // EVENT LISTENERS
  // ========================================
  
  // Login form
  const loginForm = document.querySelector("#loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        await loginWithPassword(document.querySelector("#adminPassword").value);
        const loginError = document.querySelector("#loginError");
        if (loginError) loginError.classList.remove("show");
        if (typeof renderAuth === "function") renderAuth();
        await refreshAdmin();
      } catch (error) {
        const loginError = document.querySelector("#loginError");
        if (loginError) {
          loginError.textContent = error.message || "Incorrect admin password.";
          loginError.classList.add("show");
        }
      }
    }, true);
  }

  // Logout button
  const logoutButton = document.querySelector("#logoutButton");
  if (logoutButton) {
    logoutButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      if (typeof renderAuth === "function") renderAuth();
      location.reload();
    }, true);
  }

  // Refresh button
  const refreshButton = document.querySelector("#refreshAdminButton");
  if (refreshButton) {
    refreshButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        await refreshAdmin();
        const pendingCount = window.adminLiveDB?.rooms?.pending?.length || 0;
        showNotice(`Admin posts refreshed from the live server. Pending rooms: ${pendingCount}.`);
      } catch (error) {
        window.liveAdminBackendConnected = false;
        showNotice(error.message || "Could not refresh admin posts. Check the live server and try again.");
      }
    }, true);
  }

  // Room list click handler
  const roomList = document.getElementById('roomList');
  if (roomList) {
    roomList.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const section = button.dataset.section || 'rooms';
      const from = button.dataset.from || 'pending';
      const id = button.dataset.id;
      const action = button.dataset.action;

      // Handle different actions
      if (action === "approve") {
        return adminAction({ action: "move", section, from, to: "approved", id }, "✅ Post approved and now visible on the public site.");
      }
      if (action === "decline") {
        return adminAction({ action: "move", section, from, to: "declined", id }, "❌ Post declined.");
      }
      if (action === "delete") {
        if (!confirm('⚠️ Delete this item permanently?')) return;
        return adminAction({ action: "delete", section, from, id }, "🗑️ Item deleted.");
      }
      if (action === "repost") {
        return adminAction({ action: "move", section, from, to: "pending", id }, "🔄 Item moved back to Pending.");
      }
      if (action === "mark-taken" || action === "issue-receipt") {
        // Handle marking as taken with receipt
        const room = window.adminLiveDB?.rooms?.approved?.find(r => r.id === id);
        if (room && typeof fillReceiptForm === "function") {
          fillReceiptForm(room);
        }
        return;
      }
      if (action === "download-receipt") {
        const room = window.adminLiveDB?.rooms?.taken?.find(r => r.id === id);
        if (room && typeof openReceiptWindow === "function") {
          openReceiptWindow(room);
        }
        return;
      }
      if (action === "edit") {
        // Handle edit - this will be handled by the edit modal in the main admin
        if (typeof openEditRoomModal === "function") {
          openEditRoomModal(id, from);
        }
        return;
      }
      if (action === "approve-transport") {
        return adminAction({ action: "move", section: "transports", from, to: "approved", id }, "✅ Transport approved.");
      }
      if (action === "decline-transport") {
        return adminAction({ action: "move", section: "transports", from, to: "declined", id }, "❌ Transport declined.");
      }
      if (action === "remove-transport") {
        return adminAction({ action: "move", section: "transports", from, to: "removed", id }, "🗑️ Transport removed.");
      }
    }, true);
  }

  // ========================================
  // RECEIPT FORM HANDLING
  // ========================================
  const receiptForm = document.querySelector("#receiptForm");
  if (receiptForm) {
    const receiptRentAmount = document.querySelector("#receiptRentAmount");
    const receiptServiceFee = document.querySelector("#receiptServiceFee");
    const serviceFeeHint = document.querySelector("#serviceFeeHint");

    function updateReceiptFee() {
      const fee = serviceFeeForRent(receiptRentAmount?.value || '');
      if (receiptServiceFee) receiptServiceFee.value = fee ? `R${fee}` : "R0";
      if (serviceFeeHint) {
        serviceFeeHint.textContent = fee
          ? `Calculated service fee: R${fee}.`
          : "No service-fee band matched this rent amount.";
      }
    }

    if (receiptRentAmount) {
      receiptRentAmount.addEventListener("input", updateReceiptFee);
    }

    receiptForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = document.querySelector("#receiptRoomId")?.value;
      const receipt = {
        date: document.querySelector("#receiptDate")?.value || new Date().toISOString().slice(0, 10),
        tenantName: document.querySelector("#tenantName")?.value.trim() || 'Unknown tenant',
        tenantNumber: document.querySelector("#tenantNumber")?.value.trim() || '',
        paymentType: document.querySelector("#receiptPaymentType")?.value.trim() || 'Cash',
        roomAddress: document.querySelector("#receiptRoomAddress")?.value.trim() || '',
        rentAmount: document.querySelector("#receiptRentAmount")?.value.trim() || '0',
        depositAmount: document.querySelector("#receiptDepositAmount")?.value.trim() || '0',
        serviceFee: serviceFeeForRent(document.querySelector("#receiptRentAmount")?.value || '0')
      };
      try {
        await api("/api/admin/action", {
          method: "POST",
          body: JSON.stringify(id
            ? { action: "mark-taken", id, receipt }
            : { action: "manual-receipt", receipt, title: "Manual receipt" })
        });
        await refreshAdmin();
        const taken = window.adminLiveDB?.rooms?.taken || [];
        const room = taken.find((item) => item.id === id) || taken[0];
        if (room && typeof openReceiptWindow === "function") {
          openReceiptWindow(room);
        }
        if (receiptForm) receiptForm.reset();
        updateReceiptFee();
        showNotice("✅ Receipt saved and opened for download.");
      } catch (error) {
        window.liveAdminBackendConnected = false;
        showNotice(error.message || "Receipt could not be saved.");
      }
    }, true);
  }

  // ========================================
  // INITIALIZATION
  // ========================================
  if (token()) {
    sessionStorage.setItem(SESSION_KEY, "yes");
    refreshAdmin().catch(() => {
      window.liveAdminBackendConnected = false;
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      if (typeof renderAuth === "function") renderAuth();
    });
  } else {
    sessionStorage.removeItem(SESSION_KEY);
    window.adminLiveDB = null;
    if (typeof renderAuth === "function") renderAuth();
  }

  window.addEventListener("focus", () => {
    if (token() && sessionStorage.getItem(SESSION_KEY) === "yes") {
      refreshAdmin().catch(() => {});
    }
  });

  // ========================================
  // EXPOSE FUNCTIONS TO GLOBAL SCOPE
  // ========================================
  window.serviceFeeForRent = serviceFeeForRent;
  window.adminAction = adminAction;
  window.refreshAdmin = refreshAdmin;
  window.loginWithPassword = loginWithPassword;
  window.showNotice = showNotice;
  window.liveDB = () => liveDB;

})();
