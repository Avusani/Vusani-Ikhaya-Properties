(function () {
  window.liveBackendReady = true;
  window.liveBackendConnected = false;

  let apiRooms = [];
  let apiReviews = [];
  let apiTransports = [];

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  async function loadPublicData() {
    const data = await api("/api/public");
    window.liveBackendConnected = true;
    apiRooms = data.rooms || [];
    apiReviews = data.reviews || [];
    apiTransports = data.transports || [];
    renderRooms();
    if (typeof renderTransports === "function") renderTransports();
  }

  window.getApprovedRooms = function () {
    return apiRooms;
  };

  window.getPendingRooms = function () {
    return [];
  };

  window.getAllRooms = function () {
    return apiRooms;
  };

  window.getApprovedReviews = function (roomId) {
    return apiReviews.filter((review) => review.roomId === roomId);
  };

  window.getApprovedTransports = function () {
    return apiTransports;
  };

  window.renderRooms = function () {
    const rooms = filteredRooms();
    roomsGrid.innerHTML = rooms.length
      ? rooms.map(roomCard).join("")
      : `<p class="address">No rooms match the selected filters.</p>`;
  };

  document.addEventListener("submit", async (event) => {
    const reviewForm = event.target.closest("[data-review-form]");
    if (!reviewForm) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const roomId = reviewForm.dataset.reviewForm;
    const room = apiRooms.find((item) => item.id === roomId);
    try {
      await api("/api/reviews", {
        method: "POST",
        body: JSON.stringify({
          roomId,
          roomTitle: room ? room.title : "Room listing",
          name: reviewForm.elements.name.value.trim(),
          rating: reviewForm.elements.rating.value,
          comment: reviewForm.elements.comment.value.trim()
        })
      });
      reviewForm.reset();
      alert("Thank you. Your review was sent to admin for approval.");
    } catch (error) {
      showError(error.message || "Could not submit the review. Please try again.");
    }
  }, true);

  document.querySelector("#postForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    hideError();

    let uploadedImages = [];
    let uploadedVideo = "";
    try {
      uploadedImages = await uploadedRoomImages();
      uploadedVideo = await uploadedRoomVideo();
      await api("/api/rooms", {
        method: "POST",
        body: JSON.stringify({
          title: `${document.querySelector("#postType").value} - ${document.querySelector("#postAddress").value}`.trim(),
          location: document.querySelector("#postLocation").value,
          address: document.querySelector("#postAddress").value.trim(),
          type: document.querySelector("#postType").value,
          roomType: document.querySelector("#postRoomType").value,
          amount: money(document.querySelector("#postAmount").value),
          deposit: document.querySelector("#postDeposit").value.trim() || "No deposit stated",
          childFriendly: document.querySelector("#postChild").value,
          parking: document.querySelector("#postParking").value,
          bath: document.querySelector("#postBath").value.trim(),
          images: uploadedImages,
          video: uploadedVideo,
          posterName: document.querySelector("#posterName").value.trim(),
          posterContact: document.querySelector("#posterContact").value.trim(),
          notes: document.querySelector("#postNotes").value.trim()
        })
      });
    } catch (error) {
      showError(error.message || "Could not submit the room. Please try again.");
      return;
    }

    event.target.reset();
    clearPreviewURLs();
    imagePreview.innerHTML = `<span class="hint">No pictures selected yet.</span>`;
    videoPreview.innerHTML = `<span class="hint">No video selected yet.</span>`;
    document.querySelector("#successMessage").classList.add("is-visible");
    setTimeout(() => document.querySelector("#successMessage").classList.remove("is-visible"), 4500);
  }, true);

  document.querySelector("#scamForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      await api("/api/reports", {
        method: "POST",
        body: JSON.stringify({
          room: document.querySelector("#reportRoom").value.trim(),
          reporterContact: document.querySelector("#reporterContact").value.trim(),
          reason: document.querySelector("#reportReason").value.trim()
        })
      });
      event.target.reset();
      document.querySelector("#scamSuccess").classList.add("is-visible");
      setTimeout(() => document.querySelector("#scamSuccess").classList.remove("is-visible"), 4200);
    } catch (error) {
      showError(error.message || "Could not submit the scam report. Please try again.");
    }
  }, true);

  const transportForm = document.querySelector("#transportForm");
  if (transportForm) transportForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const transportError = document.querySelector("#transportError");
    transportError.textContent = "";
    transportError.classList.remove("is-visible");

    try {
      await api("/api/transports", {
        method: "POST",
        body: JSON.stringify({
          firstName: document.querySelector("#driverFirstName").value.trim(),
          surname: document.querySelector("#driverSurname").value.trim(),
          phone: document.querySelector("#driverPhone").value.trim(),
          email: document.querySelector("#driverEmail").value.trim(),
          localPrice: money(document.querySelector("#localPrice").value),
          outsidePrice: money(document.querySelector("#outsidePrice").value),
          carPicture: await uploadedSingleImage("#carPictureFile", "a car picture"),
          idPicture: await uploadedSingleImage("#driverIdFile", "an ID or passport picture"),
          notes: document.querySelector("#transportNotes").value.trim()
        })
      });
    } catch (error) {
      transportError.textContent = error.message || "Could not submit transport. Please try again.";
      transportError.classList.add("is-visible");
      return;
    }

    event.target.reset();
    document.querySelector("#transportSuccess").classList.add("is-visible");
    setTimeout(() => document.querySelector("#transportSuccess").classList.remove("is-visible"), 4500);
  }, true);

  loadPublicData().catch((error) => {
    console.error(error);
    window.liveBackendConnected = false;
    showError("Could not connect to the live room server yet. Refresh the page, then try again.");
  });
})();
