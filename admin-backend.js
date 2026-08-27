(function () {
  window.liveAdminBackendReady = true;
  window.liveAdminBackendConnected = false;

  const TOKEN_KEY = "alexandra-admin-token";
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
    const db = normalizeClientDB(await api("/api/admin/data"));
    liveDB = db;
    window.adminLiveDB = db;
    window.liveAdminBackendConnected = true;
    syncLocalStorage(db);
    renderRooms();
    if (typeof renderMonthlyReport === "function") renderMonthlyReport();
  }

  window.refreshAdminData = refreshAdmin;

  async function adminAction(payload, message) {
    try {
      await api("/api/admin/action", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await refreshAdmin();
      if (message) showNotice(message);
    } catch (error) {
      window.liveAdminBackendConnected = false;
      const messageText = error.message || "Admin action failed. Refresh and try again.";
      showNotice(messageText);
      if (/admin login required/i.test(messageText)) {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(SESSION_KEY);
        renderAuth();
      }
    }
  }

  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      await loginWithPassword(document.querySelector("#adminPassword").value);
      document.querySelector("#loginError").classList.remove("is-visible");
      renderAuth();
      await refreshAdmin();
    } catch (error) {
      const loginError = document.querySelector("#loginError");
      loginError.textContent = error.message || "Incorrect admin password.";
      loginError.classList.add("is-visible");
    }
  }, true);

  document.querySelector("#logoutButton").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    renderAuth();
  }, true);

  document.querySelector("#refreshAdminButton").addEventListener("click", async (event) => {
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

  roomList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const [section, from] = viewMap[state.view];
    const id = button.dataset.id;
    const action = button.dataset.action;

    if (action === "issue-receipt") {
      const room = getList(APPROVED_KEY).find((item) => item.id === id);
      if (room) fillReceiptForm(room);
      return;
    }
    if (action === "download-receipt") {
      const room = getList(TAKEN_KEY).find((item) => item.id === id);
      if (room) openReceiptWindow(room);
      return;
    }
    if (action === "approve") return adminAction({ action: "move", section, from, to: "approved", id }, "Post approved and now visible on the public site.");
    if (action === "decline") return adminAction({ action: "move", section, from, to: "declined", id }, "Post declined.");
    if (action === "remove") return adminAction({ action: "move", section, from, to: "removed", id }, "Room removed from the public site.");
    if (action === "approve-review") return adminAction({ action: "move", section, from, to: "approved", id }, "Review approved and now visible on the public site.");
    if (action === "decline-review") return adminAction({ action: "move", section, from, to: "declined", id }, "Review declined.");
    if (action === "approve-report") return adminAction({ action: "move", section, from, to: "approved", id }, "Scam report approved.");
    if (action === "decline-report") return adminAction({ action: "move", section, from, to: "declined", id }, "Scam report declined.");
    if (action === "approve-transport") return adminAction({ action: "move", section, from, to: "approved", id }, "Transport post approved and now visible on the public site.");
    if (action === "decline-transport") return adminAction({ action: "move", section, from, to: "declined", id }, "Transport post declined.");
    if (action === "remove-transport") return adminAction({ action: "move", section, from, to: "removed", id }, "Transport post removed from the public site.");
    if (action === "delete") return adminAction({ action: "delete", section, from, id }, "Post deleted.");
    if (action === "repost") return adminAction({ action: "repost", section, from, id }, "Room copied back to Pending for review.");
    if (action === "remove-image") return adminAction({ action: "remove-image", section, from, id, index: button.dataset.index }, "Picture removed from this room post.");
    if (action === "remove-video") return adminAction({ action: "remove-video", section, from, id }, "Video removed from this room post.");
    if (action === "recheck-review") {
      state.view = "review-pending";
      setActiveTab();
      return adminAction({ action: "move", section, from, to: "pending", id }, "Review moved back to Pending.");
    }
    if (action === "recheck-report") {
      state.view = "report-pending";
      setActiveTab();
      return adminAction({ action: "move", section, from, to: "pending", id }, "Report moved back to Scam Reports.");
    }
  }, true);

  const receiptForm = document.querySelector("#receiptForm");
  const receiptRentAmount = document.querySelector("#receiptRentAmount");
  const receiptServiceFee = document.querySelector("#receiptServiceFee");
  const serviceFeeHint = document.querySelector("#serviceFeeHint");

  function updateReceiptFee() {
    const fee = serviceFeeForRent(receiptRentAmount.value);
    receiptServiceFee.value = fee ? `R${fee}` : "R0";
    serviceFeeHint.textContent = fee
      ? `Calculated service fee: R${fee}.`
      : "No service-fee band matched this rent amount.";
  }

  function fillReceiptForm(room) {
    document.querySelector("#receiptRoomId").value = room.id || "";
    document.querySelector("#receiptDate").value = new Date().toISOString().slice(0, 10);
    document.querySelector("#tenantName").value = "";
    document.querySelector("#tenantNumber").value = "";
    document.querySelector("#receiptPaymentType").value = "Cash";
    document.querySelector("#receiptRoomAddress").value = room.address || "";
    document.querySelector("#receiptRentAmount").value = moneyNumber(room.amount) || "";
    document.querySelector("#receiptDepositAmount").value = room.deposit || "";
    updateReceiptFee();
    receiptForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function receiptFromForm() {
    const rentAmount = document.querySelector("#receiptRentAmount").value.trim();
    return {
      date: document.querySelector("#receiptDate").value,
      tenantName: document.querySelector("#tenantName").value.trim(),
      tenantNumber: document.querySelector("#tenantNumber").value.trim(),
      paymentType: document.querySelector("#receiptPaymentType").value.trim(),
      roomAddress: document.querySelector("#receiptRoomAddress").value.trim(),
      rentAmount,
      depositAmount: document.querySelector("#receiptDepositAmount").value.trim(),
      serviceFee: serviceFeeForRent(rentAmount)
    };
  }

  receiptRentAmount.addEventListener("input", updateReceiptFee);

  receiptForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const id = document.querySelector("#receiptRoomId").value;
    const receipt = receiptFromForm();
    try {
      await api("/api/admin/action", {
        method: "POST",
        body: JSON.stringify(id
          ? { action: "mark-taken", id, receipt }
          : { action: "manual-receipt", receipt, title: "Manual receipt" })
      });
      await refreshAdmin();
      const taken = getList(TAKEN_KEY);
      const room = taken.find((item) => item.id === id) || taken[0];
      if (room) openReceiptWindow(room);
      receiptForm.reset();
      updateReceiptFee();
      showNotice("Receipt saved under Taken and opened for download.");
    } catch (error) {
      window.liveAdminBackendConnected = false;
      showNotice(error.message || "Receipt could not be saved. Refresh and try again.");
    }
  }, true);

  document.querySelector("#manualReceiptButton").addEventListener("click", (event) => {
    event.preventDefault();
    document.querySelector("#receiptRoomId").value = "";
    if (!document.querySelector("#receiptDate").value) document.querySelector("#receiptDate").value = new Date().toISOString().slice(0, 10);
    updateReceiptFee();
    showNotice("Manual receipt mode ready. Fill the fields and click Create Receipt.");
  }, true);

  document.querySelector("#clearReceiptButton").addEventListener("click", () => {
    receiptForm.reset();
    document.querySelector("#receiptRoomId").value = "";
    updateReceiptFee();
  }, true);

  if (token()) {
    sessionStorage.setItem(SESSION_KEY, "yes");
    refreshAdmin().catch(() => {
      window.liveAdminBackendConnected = false;
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      renderAuth();
    });
  } else {
    sessionStorage.removeItem(SESSION_KEY);
    window.adminLiveDB = null;
    renderAuth();
  }

  window.addEventListener("focus", () => {
    if (token() && sessionStorage.getItem(SESSION_KEY) === "yes") {
      refreshAdmin().catch(() => {});
    }
  });
})();
