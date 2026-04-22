"use strict";
/* ══════════════════════════════════════════════════════
   TuiGo — app.js
   Single login. Anyone can switch Traveller ↔ Rider.
   Book → Accept/Reject → Track → Complete → Rate
   Profile photos on map. 24h auto-cleanup.
══════════════════════════════════════════════════════ */

// ─── ENTRY ───────────────────────────────────────────
window._appInit = function () {
  if (!window._fb || typeof L === "undefined") { setTimeout(window._appInit, 150); return; }
  fadeLoader();
  initAuth();
};
if (document.readyState === "complete") setTimeout(() => window._appInit?.(), 100);

// ─── STATE ───────────────────────────────────────────
let ME         = null;   // Firebase auth user
let PROFILE    = null;   // Firestore profile doc
let myLat      = null;
let myLng      = null;
let myMode     = "traveller"; // "traveller" | "rider"
let isOnline   = false;  // rider online state
let activeRide = null;   // current ride object { id, ...data }
let pendingReqId = null; // ride id shown to rider
let reqTimerId   = null;
let etaTimer     = null;
let starVal      = 0;
let map          = null;
let routeLine    = null;
let watchId      = null;
let locTick      = null;
const MARKERS    = {};   // uid → L.marker

// Unsubs
let unsubRide    = null;
let unsubSearch  = null;
let unsubNearby  = null;
let unsubHistory = null;
let unsubNotifs  = null;

// ─── LOADER ──────────────────────────────────────────
function fadeLoader() {
  setTimeout(() => {
    const el = document.getElementById("loading-screen");
    if (!el) return;
    el.style.cssText = "opacity:0;transition:opacity .4s";
    setTimeout(() => el.remove(), 450);
  }, 2500);
}

// ─── TOAST ───────────────────────────────────────────
let _toastT;
function toast(msg, ms = 2800) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.add("hidden"), ms);
}

// ─── AUTH ─────────────────────────────────────────────
function initAuth() {
  const { auth, onAuthStateChanged } = window._fb;
  onAuthStateChanged(auth, async user => {
    if (user) {
      ME = user;
      PROFILE = await loadProfile(user.uid);
      if (PROFILE) {
        showScreen("app-screen");
        bootApp();
      } else {
        showScreen("setup-screen");
        prefillSetup(user);
      }
    } else {
      ME = null; PROFILE = null;
      cleanupAll();
      showScreen("auth-screen");
    }
  });

  // Google sign-in
  document.getElementById("btn-google-signin").addEventListener("click", async () => {
    const btn = document.getElementById("btn-google-signin");
    btn.classList.add("loading");
    btn.querySelector("span").textContent = "Signing in…";
    document.getElementById("auth-err").classList.add("hidden");
    try {
      const { auth, GoogleAuthProvider, signInWithPopup } = window._fb;
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      if (e.code !== "auth/popup-closed-by-user") showErr("auth-err", "Sign-in failed. Try again.");
      btn.classList.remove("loading");
      btn.querySelector("span").textContent = "Continue with Google";
    }
  });
}

function prefillSetup(user) {
  const ph = document.getElementById("setup-gphoto");
  if (user.photoURL) { ph.src = user.photoURL; ph.classList.remove("hidden"); }
  else ph.classList.add("hidden");
  if (user.displayName) document.getElementById("f-name").value = user.displayName;
}

async function loadProfile(uid) {
  try {
    const { db, doc, getDoc } = window._fb;
    const s = await getDoc(doc(db, "users", uid));
    return s.exists() ? s.data() : null;
  } catch { return null; }
}

// ─── SETUP ───────────────────────────────────────────
document.getElementById("btn-save-profile").addEventListener("click", async () => {
  const name    = v("f-name");
  const phone   = v("f-phone");
  const wa      = v("f-wa") || phone;
  const tuition = v("f-tuition");
  const zone    = v("f-zone");
  const time    = v("f-time");
  const vehicle = v("f-vehicle");
  const vno     = v("f-vno");

  if (!name || !phone || !tuition || !zone) { showErr("setup-err", "Please fill all required fields."); return; }
  if (!/^\d{10}$/.test(phone)) { showErr("setup-err", "Enter valid 10-digit phone."); return; }

  const btn = document.getElementById("btn-save-profile");
  btn.classList.add("loading"); btn.querySelector("span").textContent = "Saving…";

  try {
    const { db, doc, setDoc } = window._fb;
    const profile = {
      uid: ME.uid,
      name, phone, wa, tuition, zone, time,
      vehicle, vno,
      email:    ME.email || "",
      photoURL: ME.photoURL || "",
      rating: 0, ratingCount: 0, totalRides: 0,
      createdAt: Date.now()
    };
    await setDoc(doc(db, "users", ME.uid), profile);
    PROFILE = profile;
    showScreen("app-screen");
    bootApp();
  } catch (e) {
    showErr("setup-err", e.message);
  } finally {
    btn.classList.remove("loading"); btn.querySelector("span").textContent = "Start TuiGo →";
  }
});

// ─── BOOT ─────────────────────────────────────────────
function bootApp() {
  fillProfileView();
  bindAppEvents();
  initMap();
  startGPS();
  cleanup24h();         // delete old rides
  listenHistory();
  listenNotifications();
}

// ─── MAP INIT ─────────────────────────────────────────
function initMap() {
  if (map) { map.remove(); map = null; }
  map = L.map("map", { zoomControl: true, attributionControl: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
}

// ─── GPS ──────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) { setMapStatus("⚠ Geolocation not supported"); return; }
  const opts = { enableHighAccuracy: true, timeout: 10000, maximumAge: 4000 };
  navigator.geolocation.getCurrentPosition(onGPS, onGPSErr, opts);
  watchId = navigator.geolocation.watchPosition(onGPS, onGPSErr, opts);
  locTick = setInterval(() => { if (myLat !== null) pushLocation(); }, 6000);
}

function onGPS(pos) {
  const { latitude: lat, longitude: lng } = pos.coords;
  const first = (myLat === null);
  myLat = lat; myLng = lng;
  setMapStatus("📍 Location active");
  updateMyMarker();
  pushLocation();
  if (first) {
    map.setView([lat, lng], 15);
    listenNearby();
  }
  // Update rider location in active ride
  if (activeRide && myMode === "rider" &&
      ["accepted","arriving","picked_up"].includes(activeRide.status)) {
    pushRiderLocToRide();
  }
}

function onGPSErr(e) { setMapStatus("⚠ " + (e.message || "Location error")); }
function setMapStatus(t) { const el = document.getElementById("map-status"); if (el) el.textContent = t; }

// ─── PUSH MY LOCATION ─────────────────────────────────
async function pushLocation() {
  if (!ME || !myLat || !PROFILE) return;
  const visible = (myMode === "traveller") || (myMode === "rider" && isOnline);
  try {
    const { db, doc, setDoc } = window._fb;
    await setDoc(doc(db, "locations", ME.uid), {
      uid:      ME.uid,
      name:     PROFILE.name,
      photoURL: PROFILE.photoURL || "",
      phone:    PROFILE.phone,
      wa:       PROFILE.wa,
      tuition:  PROFILE.tuition,
      zone:     PROFILE.zone,
      vehicle:  PROFILE.vehicle || "",
      vno:      PROFILE.vno || "",
      mode:     myMode,
      lat:      myLat,
      lng:      myLng,
      visible:  visible,
      ts:       Date.now()
    }, { merge: true });
  } catch {}
}

// ─── MARKERS ──────────────────────────────────────────
function makeIcon(photoURL, name, mode, isMe) {
  const initial = (name || "?")[0].toUpperCase();
  const border  = isMe ? "#00e5a0" : mode === "rider" ? "#ff8c42" : "#4a9eff";
  const bikeEmoji = mode === "rider" ? `<div style="position:absolute;bottom:-4px;right:-4px;font-size:14px;line-height:1">🏍️</div>` : "";
  const inner = photoURL
    ? `<img src="${photoURL}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.outerHTML='<span style=\\"color:#0c1219;font-family:Syne,sans-serif;font-weight:700;font-size:15px\\">${initial}</span>'">`
    : `<span style="color:#0c1219;font-family:Syne,sans-serif;font-weight:700;font-size:15px">${initial}</span>`;
  return L.divIcon({
    html: `<div style="
      width:40px;height:40px;border-radius:50%;
      border:3px solid ${border};
      background:${photoURL ? "#000" : (isMe ? "#00e5a0" : "#1a2535")};
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 8px rgba(0,0,0,.55);
      overflow:hidden;position:relative;">
      ${inner}${bikeEmoji}
    </div>`,
    className: "",
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -24]
  });
}

function updateMyMarker() {
  if (!map || myLat === null) return;
  const icon = makeIcon(PROFILE?.photoURL, PROFILE?.name, myMode, true);
  if (MARKERS["me"]) {
    MARKERS["me"].setLatLng([myLat, myLng]).setIcon(icon);
  } else {
    MARKERS["me"] = L.marker([myLat, myLng], { icon, zIndexOffset: 1000 })
      .addTo(map)
      .bindPopup(`<strong>You</strong><br>${PROFILE?.name || ""}`);
  }
}

function upsertMarker(uid, data) {
  if (!map || !data.lat || !data.lng) return;
  const icon = makeIcon(data.photoURL, data.name, data.mode, false);
  const popup = `<strong>${esc(data.name)}</strong><br>${data.mode === "rider" ? "🏍️ Rider" : "🎒 Traveller"}<br>${esc(data.tuition || "")}`;
  if (MARKERS[uid]) {
    MARKERS[uid].setLatLng([data.lat, data.lng]).setIcon(icon);
  } else {
    MARKERS[uid] = L.marker([data.lat, data.lng], { icon }).addTo(map).bindPopup(popup);
  }
}

function removeMarker(uid) {
  if (MARKERS[uid]) { map.removeLayer(MARKERS[uid]); delete MARKERS[uid]; }
}

// ─── NEARBY USERS ─────────────────────────────────────
function listenNearby() {
  if (unsubNearby) unsubNearby();
  const { db, collection, onSnapshot, query, where } = window._fb;
  const q = query(collection(db, "locations"), where("visible", "==", true));
  unsubNearby = onSnapshot(q, snap => {
    const seen = new Set();
    let cnt = 0;
    snap.forEach(d => {
      if (d.id === ME.uid) return;
      seen.add(d.id);
      upsertMarker(d.id, d.data());
      cnt++;
    });
    Object.keys(MARKERS).forEach(uid => {
      if (uid !== "me" && uid !== "active-other" && !seen.has(uid)) removeMarker(uid);
    });
    const el = document.getElementById("nearby-chip");
    if (el) el.textContent = cnt + " nearby";
  });
}

// ─── MODE TOGGLE ──────────────────────────────────────
document.getElementById("btn-mode-traveller").addEventListener("click", () => setMode("traveller"));
document.getElementById("btn-mode-rider").addEventListener("click", () => setMode("rider"));

function setMode(mode) {
  if (mode === myMode) return;
  myMode = mode;
  // Update toggle UI
  document.getElementById("btn-mode-traveller").classList.toggle("active", mode === "traveller");
  document.getElementById("btn-mode-rider").classList.toggle("active", mode === "rider");
  // Show/hide FABs
  document.getElementById("btn-book-ride").classList.toggle("hidden", mode !== "traveller");
  document.getElementById("rider-online-wrap").classList.toggle("hidden", mode !== "rider");
  // If switching away from rider, go offline
  if (mode !== "rider" && isOnline) { isOnline = false; updateOnlineBtn(); }
  updateMyMarker();
  pushLocation();

  // If rider, listen for searching rides
  if (mode === "rider") {
    listenSearchingRides();
  } else {
    if (unsubSearch) { unsubSearch(); unsubSearch = null; }
  }
  toast(mode === "rider" ? "🏍️ Rider mode — go online to receive requests" : "🎒 Traveller mode — book a ride anytime");
}

// ─── RIDER ONLINE ─────────────────────────────────────
document.getElementById("btn-rider-online").addEventListener("click", () => {
  if (myMode !== "rider") return;
  isOnline = !isOnline;
  updateOnlineBtn();
  pushLocation();
  toast(isOnline ? "🟢 You're online — waiting for ride requests" : "⚫ You're offline");
});

function updateOnlineBtn() {
  const btn = document.getElementById("btn-rider-online");
  const lbl = document.getElementById("online-lbl");
  btn.classList.toggle("online", isOnline);
  btn.classList.toggle("offline", !isOnline);
  lbl.textContent = isOnline ? "Online — Tap to go offline" : "Go Online";
}

// ─── BOOK RIDE ────────────────────────────────────────
document.getElementById("btn-book-ride").addEventListener("click", async () => {
  if (!myLat) { toast("📍 Waiting for GPS location…"); return; }
  if (activeRide) { toast("You already have an active ride"); showPanel(); return; }

  const btn = document.getElementById("btn-book-ride");
  btn.disabled = true; btn.textContent = "Booking…";

  try {
    const { db, collection, addDoc } = window._fb;
    const fare = estimateFare(500); // base estimate; real fare computed on completion
    const rideDoc = {
      // traveller
      travellerId:    ME.uid,
      travellerName:  PROFILE.name,
      travellerPhone: PROFILE.phone,
      travellerWa:    PROFILE.wa,
      travellerPhoto: PROFILE.photoURL || "",
      travellerLat:   myLat,
      travellerLng:   myLng,
      tuition:        PROFILE.tuition,
      zone:           PROFILE.zone,
      // rider (filled on accept)
      riderId:        null,
      riderName:      null,
      riderPhone:     null,
      riderWa:        null,
      riderPhoto:     null,
      riderVehicle:   null,
      riderVno:       null,
      riderLat:       null,
      riderLng:       null,
      // ride info
      status:         "searching",
      fare:           fare,
      payMethod:      "cash",
      riderStatus:    "accepted", // rider's sub-status for step bar
      createdAt:      Date.now(),
      updatedAt:      Date.now()
    };
    const ref = await addDoc(collection(db, "rides"), rideDoc);
    activeRide = { id: ref.id, ...rideDoc };
    listenActiveRide(ref.id);
    showPanel();
    showRp("rp-searching");
    toast("🔍 Looking for a rider nearby…");
  } catch (e) {
    toast("Error: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "📍 Book a Ride Now";
  }
});

// ─── LISTEN FOR ACTIVE RIDE ───────────────────────────
function listenActiveRide(rideId) {
  if (unsubRide) unsubRide();
  const { db, doc, onSnapshot } = window._fb;
  unsubRide = onSnapshot(doc(db, "rides", rideId), snap => {
    if (!snap.exists()) { activeRide = null; hidePanel(); return; }
    activeRide = { id: snap.id, ...snap.data() };
    handleRideUpdate(activeRide);
  });
}

// Resume active ride on reload
async function resumeRide() {
  const { db, collection, query, where, getDocs } = window._fb;
  const active = ["searching","accepted","arriving","picked_up"];
  for (const status of active) {
    // check as traveller
    try {
      let q = query(collection(db, "rides"),
        where("travellerId", "==", ME.uid),
        where("status", "==", status));
      let snap = await getDocs(q);
      if (!snap.empty) { const d = snap.docs[0]; listenActiveRide(d.id); return; }
      // check as rider
      q = query(collection(db, "rides"),
        where("riderId", "==", ME.uid),
        where("status", "==", status));
      snap = await getDocs(q);
      if (!snap.empty) { const d = snap.docs[0]; listenActiveRide(d.id); return; }
    } catch {}
  }
}

// ─── HANDLE RIDE UPDATE ───────────────────────────────
function handleRideUpdate(ride) {
  const amTraveller = ride.travellerId === ME.uid;
  const amRider     = ride.riderId === ME.uid;

  showPanel();

  switch (ride.status) {
    case "searching":
      if (amTraveller) showRp("rp-searching");
      break;

    case "accepted":
    case "arriving":
      if (amTraveller) {
        fillTravellerActive(ride);
        showRp("rp-traveller-active");
        updateSteps("accepted");
        // Draw route from rider to traveller
        if (ride.riderLat && myLat) {
          drawRoute(ride.riderLat, ride.riderLng, myLat, myLng);
        }
        // Update rider marker on map
        if (ride.riderLat) upsertMarker("active-other", {
          lat: ride.riderLat, lng: ride.riderLng,
          name: ride.riderName, photoURL: ride.riderPhoto, mode: "rider"
        });
      } else if (amRider) {
        fillRiderActive(ride, false);
        showRp("rp-rider-active");
        // Draw route to traveller
        if (ride.travellerLat && myLat) drawRoute(myLat, myLng, ride.travellerLat, ride.travellerLng);
        if (ride.travellerLat) upsertMarker("active-other", {
          lat: ride.travellerLat, lng: ride.travellerLng,
          name: ride.travellerName, photoURL: ride.travellerPhoto, mode: "traveller"
        });
      }
      break;

    case "picked_up":
      if (amTraveller) {
        fillTravellerActive(ride);
        showRp("rp-traveller-active");
        updateSteps("picked_up");
        clearRoute();
      } else if (amRider) {
        fillRiderActive(ride, true);
        showRp("rp-rider-active");
        clearRoute();
      }
      break;

    case "completed":
      fillCompleted(ride, amTraveller);
      showRp("rp-completed");
      clearRoute();
      clearInterval(etaTimer);
      removeMarker("active-other");
      break;

    case "cancelled":
      activeRide = null;
      if (unsubRide) { unsubRide(); unsubRide = null; }
      hidePanel();
      clearRoute();
      removeMarker("active-other");
      toast("Ride was cancelled");
      break;
  }
}

// ─── FILL PANELS ──────────────────────────────────────
function fillTravellerActive(ride) {
  setImg("ta-dp", ride.riderPhoto, ride.riderName);
  setText("ta-name",    ride.riderName    || "—");
  setText("ta-vehicle", ride.riderVehicle || "");
  setText("ta-vno",     ride.riderVno     || "");
  // ETA from OSRM
  if (ride.riderLat && myLat) {
    getOSRMRoute(ride.riderLat, ride.riderLng, myLat, myLng).then(r => {
      if (r) runETA(r.duration);
    });
  }
  // Contact
  setContactLinks(
    "ta-call", "ta-wa",
    ride.riderPhone, ride.riderWa, ride.riderName
  );
}

function fillRiderActive(ride, pickedUp) {
  setImg("ra-dp", ride.travellerPhoto, ride.travellerName);
  setText("ra-name",    ride.travellerName || "—");
  setText("ra-tuition", ride.tuition       || "—");
  setText("ra-fare",    "₹" + (ride.fare   || "—"));
  setContactLinks(
    "ra-call", "ra-wa",
    ride.travellerPhone, ride.travellerWa, ride.travellerName
  );
  // Navigate to traveller
  const nav = document.getElementById("ra-nav");
  if (ride.travellerLat) {
    nav.href = `https://www.google.com/maps/dir/?api=1&destination=${ride.travellerLat},${ride.travellerLng}`;
  }
  // Status button
  const btn = document.getElementById("btn-rider-status");
  if (!pickedUp) {
    btn.textContent = "Mark Picked Up";
    btn.onclick     = () => updateRideStatus("picked_up");
  } else {
    btn.textContent = "Mark Arrived (Complete Ride)";
    btn.onclick     = () => completeRide();
  }
}

function fillCompleted(ride, amTraveller) {
  const fare = computeFinalFare(ride);
  setText("fare-box", `Fare: ₹${fare}`);
  // UPI
  const upiPhone = amTraveller ? ride.riderWa : ride.travellerWa;
  const upiName  = amTraveller ? ride.riderName : ride.travellerName;
  if (upiPhone) {
    document.getElementById("upi-id").textContent = "+91" + upiPhone + "@upi";
    document.getElementById("upi-link").href =
      `upi://pay?pa=${upiPhone}@upi&pn=${encodeURIComponent(upiName || "TuiGo")}&am=${fare}&cu=INR`;
  }
}

// ─── CANCEL RIDE ──────────────────────────────────────
document.getElementById("btn-cancel-search").addEventListener("click",    () => doCancel());
document.getElementById("btn-cancel-ride-t").addEventListener("click",    () => doCancel());
document.getElementById("btn-cancel-ride-r").addEventListener("click",    () => doCancel());

async function doCancel() {
  if (!activeRide) return;
  try {
    const { db, doc, updateDoc } = window._fb;
    await updateDoc(doc(db, "rides", activeRide.id), {
      status: "cancelled", updatedAt: Date.now()
    });
    // notify other party
    const otherId = activeRide.riderId === ME.uid
      ? activeRide.travellerId : activeRide.riderId;
    if (otherId) pushNotif(otherId, "Ride Cancelled", "Your ride was cancelled.");
  } catch (e) { toast("Error: " + e.message); }
  activeRide = null;
  if (unsubRide) { unsubRide(); unsubRide = null; }
  hidePanel();
  clearRoute();
  removeMarker("active-other");
}

// ─── UPDATE RIDE STATUS ───────────────────────────────
async function updateRideStatus(status) {
  if (!activeRide) return;
  try {
    const { db, doc, updateDoc } = window._fb;
    await updateDoc(doc(db, "rides", activeRide.id), { status, updatedAt: Date.now() });
    if (status === "picked_up") {
      pushNotif(activeRide.travellerId, "Rider arrived! 🏍️", "Your rider has picked you up.");
    }
  } catch (e) { toast("Error: " + e.message); }
}

async function completeRide() {
  if (!activeRide) return;
  const fare = computeFinalFare(activeRide);
  try {
    const { db, doc, updateDoc } = window._fb;
    await updateDoc(doc(db, "rides", activeRide.id), {
      status: "completed", fare, completedAt: Date.now(), updatedAt: Date.now()
    });
    // Increment rides count
    await updateDoc(doc(db, "users", ME.uid), {
      totalRides: (PROFILE.totalRides || 0) + 1
    });
    PROFILE.totalRides = (PROFILE.totalRides || 0) + 1;
    document.getElementById("pi-rides").textContent = PROFILE.totalRides;
    pushNotif(activeRide.travellerId, "Arrived! ✅", "Your ride is complete. Please rate your rider.");
  } catch (e) { toast("Error: " + e.message); }
}

// ─── PUSH RIDER LOCATION TO RIDE DOC ──────────────────
async function pushRiderLocToRide() {
  if (!activeRide || !myLat) return;
  try {
    const { db, doc, updateDoc } = window._fb;
    await updateDoc(doc(db, "rides", activeRide.id), {
      riderLat: myLat, riderLng: myLng,
      status: activeRide.status === "accepted" ? "arriving" : activeRide.status,
      updatedAt: Date.now()
    });
  } catch {}
}

// ─── RIDER: LISTEN FOR SEARCHING RIDES ───────────────
function listenSearchingRides() {
  if (unsubSearch) unsubSearch();
  const { db, collection, onSnapshot, query, where } = window._fb;
  const q = query(collection(db, "rides"), where("status", "==", "searching"));
  unsubSearch = onSnapshot(q, snap => {
    if (activeRide) return; // already on a ride
    if (!isOnline) return;  // not accepting
    snap.forEach(d => {
      const ride = { id: d.id, ...d.data() };
      if (ride.travellerId === ME.uid) return; // own booking
      if (pendingReqId === ride.id) return;    // already showing
      if (pendingReqId) return;                // already showing another
      pendingReqId = ride.id;
      showRideRequest(ride);
    });
    // Clear request if no longer searching
    if (pendingReqId && !snap.docs.find(d => d.id === pendingReqId)) {
      pendingReqId = null;
      if (!activeRide) hidePanel();
    }
  });
}

function showRideRequest(ride) {
  const dist = (myLat && ride.travellerLat)
    ? haversine(myLat, myLng, ride.travellerLat, ride.travellerLng).toFixed(1) + " km"
    : "Unknown";
  const fare = estimateFare(parseFloat(dist) * 1000 || 500);

  setImg("req-dp", ride.travellerPhoto, ride.travellerName);
  setText("req-name",    ride.travellerName || "—");
  setText("req-tuition", ride.tuition       || "—");
  setText("req-zone",    "Zone " + (ride.zone || "—"));
  setText("req-dist",    dist);
  setText("req-fare",    "₹" + fare + " (est.)");

  showPanel();
  showRp("rp-rider-request");
  startReqTimer(ride);
}

function startReqTimer(ride) {
  clearInterval(reqTimerId);
  let t = 30;
  const arc = document.getElementById("req-arc");
  const num = document.getElementById("req-timer-num");
  const circ = 125.6;
  reqTimerId = setInterval(() => {
    t--;
    num.textContent = t;
    arc.setAttribute("stroke-dashoffset", ((30 - t) / 30) * circ);
    if (t <= 0) {
      clearInterval(reqTimerId);
      pendingReqId = null;
      hidePanel();
      toast("Request expired");
    }
  }, 1000);
}

// Accept
document.getElementById("btn-accept").addEventListener("click", async () => {
  if (!pendingReqId) return;
  clearInterval(reqTimerId);
  const rideId = pendingReqId;
  pendingReqId = null;

  try {
    const { db, doc, runTransaction } = window._fb;
    await runTransaction(db, async tx => {
      const snap = await tx.get(doc(db, "rides", rideId));
      if (!snap.exists() || snap.data().status !== "searching") {
        throw new Error("Ride no longer available");
      }
      tx.update(doc(db, "rides", rideId), {
        riderId:      ME.uid,
        riderName:    PROFILE.name,
        riderPhone:   PROFILE.phone,
        riderWa:      PROFILE.wa,
        riderPhoto:   PROFILE.photoURL || "",
        riderVehicle: PROFILE.vehicle || "",
        riderVno:     PROFILE.vno     || "",
        riderLat:     myLat,
        riderLng:     myLng,
        status:       "accepted",
        acceptedAt:   Date.now(),
        updatedAt:    Date.now()
      });
    });
    listenActiveRide(rideId);
    toast("✅ Ride accepted!");
    // notify traveller
    const { db: db2, doc: doc2, getDoc: getDoc2 } = window._fb;
    const rSnap = await getDoc2(doc2(db2, "rides", rideId));
    if (rSnap.exists()) {
      pushNotif(rSnap.data().travellerId, "🏍️ Rider found!", `${PROFILE.name} accepted your ride. ETA coming soon.`);
    }
  } catch (e) {
    toast("⚠ " + e.message);
    pendingReqId = null;
    hidePanel();
  }
});

// Reject
document.getElementById("btn-reject").addEventListener("click", () => {
  clearInterval(reqTimerId);
  pendingReqId = null;
  hidePanel();
  toast("Request rejected");
});

// ─── DONE & RATE ──────────────────────────────────────
document.getElementById("btn-done-rate").addEventListener("click", () => {
  const ride = activeRide;
  activeRide = null;
  if (unsubRide) { unsubRide(); unsubRide = null; }
  hidePanel();
  if (ride) openRating(ride);
});

// ─── RATING MODAL ─────────────────────────────────────
function openRating(ride) {
  starVal = 0;
  const amTraveller = ride.travellerId === ME.uid;
  const whom = amTraveller ? ride.riderName : ride.travellerName;
  setText("rating-whom", "Rate " + (whom || "your ride"));
  document.querySelectorAll("#stars .star").forEach(s => s.classList.remove("on"));
  document.getElementById("rating-comment").value = "";
  document.getElementById("rating-modal").classList.remove("hidden");

  document.querySelectorAll("#stars .star").forEach(s => {
    s.onclick = () => {
      starVal = parseInt(s.dataset.v);
      document.querySelectorAll("#stars .star").forEach(x =>
        x.classList.toggle("on", parseInt(x.dataset.v) <= starVal)
      );
    };
  });

  document.getElementById("btn-submit-rating").onclick = async () => {
    if (!starVal) { toast("Please select a star rating"); return; }
    await submitRating(ride, starVal);
    document.getElementById("rating-modal").classList.add("hidden");
    toast("⭐ Rating submitted. Thanks!");
  };
  document.getElementById("btn-skip-rating").onclick = () => {
    document.getElementById("rating-modal").classList.add("hidden");
  };
}

async function submitRating(ride, stars) {
  const amTraveller = ride.travellerId === ME.uid;
  const ratedUid = amTraveller ? ride.riderId : ride.travellerId;
  if (!ratedUid) return;
  try {
    const { db, doc, updateDoc, getDoc } = window._fb;
    const snap = await getDoc(doc(db, "users", ratedUid));
    if (snap.exists()) {
      const u = snap.data();
      await updateDoc(doc(db, "users", ratedUid), {
        rating:      (u.rating      || 0) + stars,
        ratingCount: (u.ratingCount || 0) + 1
      });
    }
    await updateDoc(doc(db, "rides", ride.id), {
      [amTraveller ? "travellerRating" : "riderRating"]: stars
    });
  } catch {}
}

// ─── PAYMENT CHIPS ────────────────────────────────────
document.querySelectorAll(".pay-chip").forEach(c => {
  c.addEventListener("click", () => {
    document.querySelectorAll(".pay-chip").forEach(x => x.classList.remove("active"));
    c.classList.add("active");
    const isUPI = c.dataset.pay === "upi";
    document.getElementById("upi-section").classList.toggle("hidden", !isUPI);
    if (activeRide) {
      const { db, doc, updateDoc } = window._fb;
      updateDoc(doc(db, "rides", activeRide.id), { payMethod: c.dataset.pay }).catch(() => {});
    }
  });
});

// ─── ROUTE DRAWING ───────────────────────────────────
async function drawRoute(fromLat, fromLng, toLat, toLng) {
  clearRoute();
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.routes?.[0]) return null;
    const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    routeLine = L.polyline(coords, { color: "#00e5a0", weight: 4, opacity: .8 }).addTo(map);
    return { duration: data.routes[0].duration, distance: data.routes[0].distance };
  } catch { return null; }
}

async function getOSRMRoute(fromLat, fromLng, toLat, toLng) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
    const res  = await fetch(url);
    const data = await res.json();
    return data.routes?.[0] ? { duration: data.routes[0].duration, distance: data.routes[0].distance } : null;
  } catch { return null; }
}

function clearRoute() {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
}

// ─── ETA ─────────────────────────────────────────────
function runETA(seconds) {
  clearInterval(etaTimer);
  let rem = Math.round(seconds);
  updateETA(rem);
  etaTimer = setInterval(() => {
    rem--;
    if (rem <= 0) { clearInterval(etaTimer); return; }
    updateETA(rem);
  }, 1000);
}
function updateETA(sec) {
  const el = document.getElementById("ta-eta");
  if (!el) return;
  el.textContent = sec < 60 ? sec + "s" : Math.ceil(sec / 60) + " min";
}

// ─── STATUS STEPS ─────────────────────────────────────
function updateSteps(status) {
  const map2 = { accepted: 0, arriving: 1, picked_up: 2, completed: 3 };
  const idx  = map2[status] ?? 0;
  const ids  = ["ss-accepted","ss-arriving","ss-onway","ss-done"];
  const lines= ["sl-1","sl-2","sl-3"];
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("active", i === idx);
    el.classList.toggle("done",   i < idx);
  });
  lines.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("done", i < idx);
  });
}

// ─── NOTIFICATIONS ────────────────────────────────────
async function pushNotif(uid, title, body) {
  if (!uid) return;
  try {
    const { db, collection, addDoc } = window._fb;
    await addDoc(collection(db, "notifications", uid, "items"), {
      title, body, read: false, ts: Date.now()
    });
  } catch {}
}

function listenNotifications() {
  if (unsubNotifs) unsubNotifs();
  const { db, collection, onSnapshot, query, orderBy, limit } = window._fb;
  const q = query(
    collection(db, "notifications", ME.uid, "items"),
    orderBy("ts", "desc"), limit(30)
  );
  unsubNotifs = onSnapshot(q, snap => {
    const list  = document.getElementById("notif-list");
    let unread  = 0;
    if (snap.empty) {
      list.innerHTML = `<div class="empty-state"><p>No notifications</p></div>`;
      document.getElementById("notif-dot").classList.add("hidden");
      return;
    }
    list.innerHTML = "";
    snap.forEach(d => {
      const n = d.data();
      if (!n.read) unread++;
      const el = document.createElement("div");
      el.className = "notif-item" + (n.read ? "" : " unread");
      el.innerHTML = `<div class="notif-body">
        <div class="notif-text"><strong>${esc(n.title)}</strong> ${esc(n.body)}</div>
        <div class="notif-time">${timeAgo(n.ts)}</div></div>`;
      el.onclick = () => {
        const { db: d2, doc: doc2, updateDoc: upd } = window._fb;
        upd(doc2(d2, "notifications", ME.uid, "items", d.id), { read: true }).catch(() => {});
        el.classList.remove("unread");
      };
      list.appendChild(el);
    });
    document.getElementById("notif-dot").classList.toggle("hidden", unread === 0);
  });
}

// ─── RIDE HISTORY ─────────────────────────────────────
function listenHistory() {
  if (unsubHistory) unsubHistory();
  const { db, collection, onSnapshot, query, where, orderBy, limit } = window._fb;
  // Listen to rides where user is traveller OR rider (two separate queries merged)
  const qT = query(
    collection(db, "rides"),
    where("travellerId", "==", ME.uid),
    orderBy("createdAt", "desc"), limit(15)
  );
  const qR = query(
    collection(db, "rides"),
    where("riderId", "==", ME.uid),
    orderBy("createdAt", "desc"), limit(15)
  );
  const combined = new Map();
  function render() {
    const list = document.getElementById("history-list");
    if (!combined.size) {
      list.innerHTML = `<div class="empty-state"><p>No rides yet</p><small>Rides are auto-cleared every 24 hours</small></div>`;
      return;
    }
    const sorted = [...combined.values()].sort((a, b) => b.createdAt - a.createdAt);
    list.innerHTML = sorted.map(r => {
      const role  = r.travellerId === ME.uid ? "Traveller" : "Rider";
      const other = r.travellerId === ME.uid ? r.riderName : r.travellerName;
      const chipCls = r.status === "completed" ? "s-done" : r.status === "cancelled" ? "s-cancelled" : "s-active";
      const ts = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "";
      return `<div class="history-card">
        <div class="hc-left">
          <h4>${esc(r.tuition || "Ride")}</h4>
          <p>${role} · ${esc(other || "—")} · ${ts}</p>
        </div>
        <div class="hc-right">
          <span class="status-chip ${chipCls}">${r.status}</span><br/>
          <span class="hc-fare">₹${r.fare || "—"}</span>
        </div>
      </div>`;
    }).join("");
  }
  unsubHistory  = onSnapshot(qT, snap => {
    snap.forEach(d => combined.set(d.id, { id: d.id, ...d.data() }));
    snap.docChanges().forEach(c => { if (c.type === "removed") combined.delete(c.doc.id); });
    render();
  });
  // Second listener for rider rides
  const unsubR = onSnapshot(qR, snap => {
    snap.forEach(d => combined.set(d.id, { id: d.id, ...d.data() }));
    snap.docChanges().forEach(c => { if (c.type === "removed") combined.delete(c.doc.id); });
    render();
  });
  // Store second unsub
  window._unsubHistoryR = unsubR;
}

// ─── 24H CLEANUP ─────────────────────────────────────
async function cleanup24h() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const { db, collection, query, where, getDocs, writeBatch, doc } = window._fb;
    // Delete old rides (traveller or rider)
    for (const field of ["travellerId", "riderId"]) {
      const q = query(
        collection(db, "rides"),
        where(field, "==", ME.uid),
        where("createdAt", "<", cutoff)
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        const batch = writeBatch(db);
        snap.forEach(d => batch.delete(doc(db, "rides", d.id)));
        await batch.commit();
      }
    }
    // Delete old notifications
    const qN = query(
      collection(db, "notifications", ME.uid, "items"),
      where("ts", "<", cutoff)
    );
    const snapN = await getDocs(qN);
    if (!snapN.empty) {
      const batch = writeBatch(db);
      snapN.forEach(d => batch.delete(doc(db, "notifications", ME.uid, "items", d.id)));
      await batch.commit();
    }
    // Delete own stale location (>5 min)
    const locCutoff = Date.now() - 5 * 60 * 1000;
    const qL = query(collection(db, "locations"), where("uid", "==", ME.uid));
    const snapL = await getDocs(qL);
    snapL.forEach(async d => {
      if ((d.data().ts || 0) < locCutoff) {
        const { deleteDoc: del } = window._fb;
        await del(doc(db, "locations", d.id)).catch(() => {});
      }
    });
  } catch {}
}

// ─── EDIT PROFILE ────────────────────────────────────
document.getElementById("btn-edit-profile").addEventListener("click", () => {
  document.getElementById("ep-name").value    = PROFILE.name    || "";
  document.getElementById("ep-phone").value   = PROFILE.phone   || "";
  document.getElementById("ep-wa").value      = PROFILE.wa      || "";
  document.getElementById("ep-tuition").value = PROFILE.tuition || "";
  document.getElementById("ep-zone").value    = PROFILE.zone    || "A";
  document.getElementById("ep-time").value    = PROFILE.time    || "";
  document.getElementById("ep-vehicle").value = PROFILE.vehicle || "";
  document.getElementById("ep-vno").value     = PROFILE.vno     || "";
  document.getElementById("edit-modal").classList.remove("hidden");
});
document.getElementById("btn-edit-close").addEventListener("click", () => {
  document.getElementById("edit-modal").classList.add("hidden");
});
document.getElementById("btn-save-edit").addEventListener("click", async () => {
  const updates = {
    name:    v("ep-name"),
    phone:   v("ep-phone"),
    wa:      v("ep-wa") || v("ep-phone"),
    tuition: v("ep-tuition"),
    zone:    v("ep-zone"),
    time:    v("ep-time"),
    vehicle: v("ep-vehicle"),
    vno:     v("ep-vno")
  };
  if (!updates.name || !updates.phone || !updates.tuition) { toast("Fill required fields"); return; }
  try {
    const { db, doc, updateDoc } = window._fb;
    await updateDoc(doc(db, "users", ME.uid), updates);
    PROFILE = { ...PROFILE, ...updates };
    fillProfileView();
    document.getElementById("edit-modal").classList.add("hidden");
    toast("✅ Profile updated!");
    pushLocation();
  } catch (e) { toast("Error: " + e.message); }
});

// ─── SIGN OUT ─────────────────────────────────────────
document.getElementById("btn-signout").addEventListener("click", async () => {
  cleanupAll();
  // Mark offline
  try {
    const { db, doc, updateDoc } = window._fb;
    await updateDoc(doc(db, "locations", ME.uid), { visible: false, online: false });
  } catch {}
  const { auth, signOut } = window._fb;
  await signOut(auth);
});

// ─── APP EVENT BINDINGS ───────────────────────────────
function bindAppEvents() {
  // Tabs
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".view").forEach(v2 => {
        v2.classList.remove("active"); v2.classList.add("hidden");
      });
      const t = document.getElementById("view-" + btn.dataset.view);
      if (t) { t.classList.remove("hidden"); t.classList.add("active"); }
      if (btn.dataset.view === "map" && map) setTimeout(() => map.invalidateSize(), 80);
    });
  });

  // Notif bell → go to alerts tab
  document.getElementById("btn-notifs").addEventListener("click", () => {
    document.querySelector('[data-view="notifs"]').click();
  });
  // Profile photo → go to profile tab
  document.getElementById("btn-profile-nav").addEventListener("click", () => {
    document.querySelector('[data-view="profile"]').click();
  });

  // Resume active ride check
  setTimeout(resumeRide, 1500);

  // Show book button for traveller by default
  document.getElementById("btn-book-ride").classList.remove("hidden");
}

// ─── FILL PROFILE VIEW ────────────────────────────────
function fillProfileView() {
  if (!PROFILE) return;
  const dp = document.getElementById("nav-dp");
  if (PROFILE.photoURL) { dp.src = PROFILE.photoURL; dp.style.display = "block"; }
  else dp.style.display = "none";

  setImg2("profile-big-dp", PROFILE.photoURL, PROFILE.name);
  setText("profile-name-big",  PROFILE.name        || "");
  setText("profile-email-big", PROFILE.email        || "");
  setText("pi-phone",  "+91 " + (PROFILE.phone   || "—"));
  setText("pi-wa",     "+91 " + (PROFILE.wa      || "—"));
  setText("pi-tuition", PROFILE.tuition           || "—");
  setText("pi-zone",   "Zone " + (PROFILE.zone   || "—"));
  setText("pi-time",    PROFILE.time              || "—");
  setText("pi-rides",   String(PROFILE.totalRides  || 0));
  const avg = PROFILE.ratingCount > 0
    ? (PROFILE.rating / PROFILE.ratingCount).toFixed(1) + " ★"
    : "New";
  setText("pi-rating", avg);
  if (PROFILE.vehicle) {
    setText("pi-vehicle", PROFILE.vehicle + (PROFILE.vno ? " · " + PROFILE.vno : ""));
    document.getElementById("pi-vehicle-row").style.display = "flex";
  } else {
    document.getElementById("pi-vehicle-row").style.display = "none";
  }
}

// ─── PANEL HELPERS ────────────────────────────────────
function showPanel() { document.getElementById("ride-panel").classList.remove("hidden"); }
function hidePanel()  { document.getElementById("ride-panel").classList.add("hidden"); hideAllRp(); }
function showRp(id)   { hideAllRp(); document.getElementById(id)?.classList.remove("hidden"); }
function hideAllRp()  { document.querySelectorAll(".rp").forEach(el => el.classList.add("hidden")); }

// ─── UTILS ───────────────────────────────────────────
function showScreen(id) {
  ["loading-screen","auth-screen","setup-screen","app-screen"].forEach(s => {
    document.getElementById(s)?.classList.toggle("hidden", s !== id);
  });
}
function v(id)   { return document.getElementById(id)?.value.trim() || ""; }
function setText(id, t) { const el = document.getElementById(id); if (el) el.textContent = t; }
function showErr(id, msg) { const el = document.getElementById(id); if (el) { el.textContent = msg; el.classList.remove("hidden"); } }
function esc(s)  { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function timeAgo(ts) {
  const s = Math.floor((Date.now() - (ts||0)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
}
function haversine(lat1,lng1,lat2,lng2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function estimateFare(distMeters) { return Math.max(10, Math.round(10 + distMeters/1000 * 5)); }
function computeFinalFare(ride) {
  if (ride.travellerLat && ride.riderLat) {
    const d = haversine(ride.travellerLat, ride.travellerLng, ride.riderId ? ride.riderLat : ride.travellerLat, ride.riderLng || ride.travellerLng);
    return estimateFare(d * 1000);
  }
  return ride.fare || 10;
}
function setContactLinks(callId, waId, phone, wa, name) {
  const callEl = document.getElementById(callId);
  const waEl   = document.getElementById(waId);
  if (!callEl || !waEl) return;
  const ph = phone || wa;
  if (ph) {
    callEl.href = "tel:+91" + ph;
    waEl.href   = `https://wa.me/91${wa || ph}?text=${encodeURIComponent("Hi " + (name||"") + ", I'm your TuiGo " + (callId.includes("rider") ? "student" : "rider") + "!")}`;
  }
}
function setImg(id, url, name) {
  const el = document.getElementById(id);
  if (!el) return;
  if (url) { el.src = url; el.alt = name || ""; }
  else { el.src = ""; el.alt = (name || "?")[0].toUpperCase(); }
}
function setImg2(id, url, name) { setImg(id, url, name); }

// ─── CLEANUP ─────────────────────────────────────────
function cleanupAll() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  clearInterval(locTick); clearInterval(etaTimer); clearInterval(reqTimerId);
  [unsubRide, unsubSearch, unsubNearby, unsubHistory, unsubNotifs, window._unsubHistoryR]
    .forEach(u => u?.());
  unsubRide = unsubSearch = unsubNearby = unsubHistory = unsubNotifs = null;
  if (map) { map.remove(); map = null; }
  Object.keys(MARKERS).forEach(k => delete MARKERS[k]);
  activeRide = null; pendingReqId = null; isOnline = false;
}
