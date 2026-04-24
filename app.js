"use strict";
// ═══════════════════════════════════════════════════════
//  TuiGo app.js — rebuilt from scratch for reliability
//  • Google sign-in → profile setup
//  • Traveller mode: tap map or type destination → book
//  • Rider mode: go online → accept/reject requests (30s)
//  • Real-time location on map (profile photos as markers)
//  • Full ride lifecycle with status steps + ETA
//  • 24-hour auto-cleanup of rides & locations
// ═══════════════════════════════════════════════════════

// ── Wait for Firebase ──────────────────────────────────
window.addEventListener("fb-ready", boot);
window.addEventListener("load",     boot);
let _booted = false;
function boot() {
  if (_booted || !window._fb || typeof L === "undefined") return;
  _booted = true;
  fadeLoader();
  initAuth();
}

// ── GLOBALS ────────────────────────────────────────────
let AUTH        = null;   // Firebase user
let PROF        = null;   // Firestore profile
let myLat       = null;
let myLng       = null;
let mode        = "traveller"; // "traveller" | "rider"
let riderOnline = false;
let destLat     = null;
let destLng     = null;
let destLabel   = "";
let activeRide  = null;   // { id, ...doc }
let pendingId   = null;   // ride id shown to rider
let timerInt    = null;
let etaInt      = null;
let map         = null;
let destMarker  = null;
let routePoly   = null;
const MARKS     = {};     // uid → L.marker
let unsubRide   = null;
let unsubSearch = null;
let unsubNearby = null;
let geoWatch    = null;
let locTick     = null;

// ── LOADER ─────────────────────────────────────────────
function fadeLoader() {
  setTimeout(() => {
    const el = document.getElementById("screen-loading");
    if (!el) return;
    el.style.transition = "opacity .4s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 420);
  }, 2500);
}

// ── TOAST ──────────────────────────────────────────────
let _tt;
function toast(msg, ms = 3000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.add("hidden"), ms);
}

// ── AUTH ───────────────────────────────────────────────
function initAuth() {
  const { auth, onAuthStateChanged } = window._fb;
  onAuthStateChanged(auth, async user => {
    if (user) {
      AUTH = user;
      PROF = await loadProfile(user.uid);
      if (PROF) {
        showScreen("app");
        startApp();
      } else {
        showScreen("setup");
        prefillSetup(user);
      }
    } else {
      AUTH = null; PROF = null;
      killAll();
      showScreen("auth");
    }
  });

  // Google sign-in button
  document.getElementById("btn-google").addEventListener("click", async () => {
    const btn = document.getElementById("btn-google");
    btn.classList.add("loading");
    btn.textContent = "Signing in…";
    document.getElementById("auth-err").classList.add("hidden");
    try {
      const { auth, GoogleAuthProvider, signInWithPopup } = window._fb;
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      document.getElementById("auth-err").textContent = e.code === "auth/popup-closed-by-user" ? "" : "Sign-in failed. Try again.";
      document.getElementById("auth-err").classList.toggle("hidden", e.code === "auth/popup-closed-by-user");
      btn.classList.remove("loading");
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg> Sign in with Google`;
    }
  });
}

async function loadProfile(uid) {
  try {
    const { db, doc, getDoc } = window._fb;
    const s = await getDoc(doc(db, "users", uid));
    return s.exists() ? s.data() : null;
  } catch { return null; }
}

function prefillSetup(user) {
  const ph = document.getElementById("g-photo");
  if (user.photoURL) { ph.src = user.photoURL; ph.classList.remove("hidden"); } else ph.classList.add("hidden");
  if (user.displayName) document.getElementById("s-name").value = user.displayName;
}

// ── SETUP ──────────────────────────────────────────────
document.getElementById("btn-save-setup").addEventListener("click", async () => {
  const name    = val("s-name");
  const phone   = val("s-phone");
  const wa      = val("s-wa") || phone;
  const vehicle = val("s-vehicle");
  const vno     = val("s-vno");
  const errEl   = document.getElementById("setup-err");
  errEl.classList.add("hidden");

  if (!name)  { showErr(errEl, "Please enter your name."); return; }
  if (!phone) { showErr(errEl, "Please enter your phone number."); return; }
  if (!/^\d{10}$/.test(phone)) { showErr(errEl, "Enter a valid 10-digit phone number."); return; }

  const btn = document.getElementById("btn-save-setup");
  btn.textContent = "Saving…"; btn.classList.add("loading");
  try {
    const { db, doc, setDoc } = window._fb;
    const profile = {
      uid:      AUTH.uid,
      name, phone, wa, vehicle, vno,
      email:    AUTH.email    || "",
      photoURL: AUTH.photoURL || "",
      rating: 0, ratingCount: 0, totalRides: 0,
      createdAt: Date.now()
    };
    await setDoc(doc(db, "users", AUTH.uid), profile);
    PROF = profile;
    showScreen("app");
    startApp();
  } catch (e) {
    showErr(errEl, "Failed: " + e.message);
  } finally {
    btn.textContent = "Save & Continue"; btn.classList.remove("loading");
  }
});

// ── APP BOOT ───────────────────────────────────────────
function startApp() {
  fillProfileTab();
  bindTabs();
  bindModeToggle();
  bindBooking();
  bindRiderOnline();
  bindPanel();
  bindEditProfile();
  bindSignOut();
  initMap();
  startGPS();
  loadHistory();
  cleanup24h();
}

// ── MAP ────────────────────────────────────────────────
function initMap() {
  if (map) { map.remove(); map = null; }
  map = L.map("map", { zoomControl: false, attributionControl: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  // Tap map to set destination (traveller mode)
  map.on("click", e => {
    if (mode !== "traveller") return;
    if (activeRide) return;
    destLat = e.latlng.lat;
    destLng = e.latlng.lng;
    destLabel = `${destLat.toFixed(5)}, ${destLng.toFixed(5)}`;
    document.getElementById("dest-input").value = destLabel;
    document.getElementById("tap-hint").textContent = "✅ Destination set! Tap to change.";
    placeDestMarker(destLat, destLng);
  });
}

function placeDestMarker(lat, lng) {
  if (destMarker) map.removeLayer(destMarker);
  destMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      html: `<div style="width:16px;height:16px;border-radius:50%;background:#ff4d6d;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5)"></div>`,
      className: "", iconSize: [16, 16], iconAnchor: [8, 8]
    })
  }).addTo(map).bindPopup("📍 Destination");
}

// ── GPS ────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) { document.getElementById("my-loc-txt").textContent = "Not supported"; return; }
  const opts = { enableHighAccuracy: true, timeout: 12000, maximumAge: 3000 };
  navigator.geolocation.getCurrentPosition(onPos, onPosErr, opts);
  geoWatch = navigator.geolocation.watchPosition(onPos, onPosErr, opts);
  locTick  = setInterval(pushMyLoc, 7000);
}

function onPos(pos) {
  const { latitude: lat, longitude: lng } = pos.coords;
  const first = myLat === null;
  myLat = lat; myLng = lng;
  document.getElementById("my-loc-txt").textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  updateMyMarker();
  pushMyLoc();
  if (first) {
    map.setView([lat, lng], 15);
    listenNearby();
  }
  // If rider is on an active ride, push location to ride doc
  if (activeRide && mode === "rider" && ["accepted","arriving","picked_up"].includes(activeRide.status)) {
    updateRiderLocInRide();
  }
}
function onPosErr(e) { document.getElementById("my-loc-txt").textContent = "Error: " + e.message; }

// ── MY LOCATION MARKER ─────────────────────────────────
function makeIcon(photoURL, name, isRider, isMe) {
  const color  = isMe ? "#00e5a0" : isRider ? "#ff8c42" : "#4a9eff";
  const initl  = (name || "?")[0].toUpperCase();
  const badge  = isRider ? `<div style="position:absolute;bottom:-4px;right:-4px;font-size:12px">🏍️</div>` : "";
  const img    = photoURL
    ? `<img src="${photoURL}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="this.style.display='none'">`
    : `<span style="color:#0c1219;font-family:Syne,sans-serif;font-weight:800;font-size:15px">${initl}</span>`;
  return L.divIcon({
    html: `<div style="
      position:relative;width:42px;height:42px;border-radius:50%;
      border:3px solid ${color};background:${photoURL ? "#111" : color};
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 8px rgba(0,0,0,.6);overflow:visible">
      <div style="width:100%;height:100%;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center">${img}</div>
      ${badge}
    </div>`,
    className: "", iconSize: [42, 42], iconAnchor: [21, 21], popupAnchor: [0, -26]
  });
}

function updateMyMarker() {
  if (!map || myLat === null) return;
  const icon = makeIcon(PROF?.photoURL, PROF?.name, mode === "rider", true);
  const popup = `<strong>${esc(PROF?.name || "You")}</strong><br>${mode === "rider" ? "🏍️ Rider" : "🎒 Traveller"}`;
  if (MARKS["me"]) {
    MARKS["me"].setLatLng([myLat, myLng]).setIcon(icon).setPopupContent(popup);
  } else {
    MARKS["me"] = L.marker([myLat, myLng], { icon, zIndexOffset: 1000 })
      .addTo(map).bindPopup(popup);
  }
}

function upsertMarker(uid, data) {
  if (!map || !data.lat || !data.lng) return;
  const isRider = data.mode === "rider";
  const icon    = makeIcon(data.photoURL, data.name, isRider, false);
  const popup   = `<strong>${esc(data.name || "—")}</strong><br>${isRider ? "🏍️ Rider" : "🎒 Traveller"}${data.vehicle ? "<br>" + esc(data.vehicle) : ""}`;
  if (MARKS[uid]) {
    MARKS[uid].setLatLng([data.lat, data.lng]).setIcon(icon).setPopupContent(popup);
  } else {
    MARKS[uid] = L.marker([data.lat, data.lng], { icon }).addTo(map).bindPopup(popup);
  }
}

function removeMarker(uid) {
  if (MARKS[uid]) { map.removeLayer(MARKS[uid]); delete MARKS[uid]; }
}

// ── PUSH MY LOCATION ───────────────────────────────────
async function pushMyLoc() {
  if (!AUTH || !myLat || !PROF) return;
  const visible = (mode === "traveller") || (mode === "rider" && riderOnline);
  try {
    const { db, doc, setDoc } = window._fb;
    await setDoc(doc(db, "locations", AUTH.uid), {
      uid:      AUTH.uid,
      name:     PROF.name,
      photoURL: PROF.photoURL || "",
      phone:    PROF.phone,
      wa:       PROF.wa,
      vehicle:  PROF.vehicle || "",
      mode:     mode,
      lat:      myLat,
      lng:      myLng,
      visible:  visible,
      ts:       Date.now()
    }, { merge: true });
  } catch {}
}

// ── NEARBY USERS LISTENER ──────────────────────────────
function listenNearby() {
  if (unsubNearby) { unsubNearby(); unsubNearby = null; }
  const { db, collection, onSnapshot, query, where } = window._fb;
  const q = query(collection(db, "locations"), where("visible", "==", true));
  unsubNearby = onSnapshot(q, snap => {
    const seen = new Set();
    snap.forEach(d => {
      if (d.id === AUTH.uid) return;
      seen.add(d.id);
      upsertMarker(d.id, d.data());
    });
    Object.keys(MARKS).forEach(uid => {
      if (uid !== "me" && uid !== "_active" && !seen.has(uid)) removeMarker(uid);
    });
  }, err => console.warn("nearby listener:", err.message));
}

// ── MODE TOGGLE ────────────────────────────────────────
function bindModeToggle() {
  document.getElementById("btn-traveller").addEventListener("click", () => setMode("traveller"));
  document.getElementById("btn-rider").addEventListener("click",     () => setMode("rider"));
}

function setMode(m) {
  mode = m;
  document.getElementById("btn-traveller").classList.toggle("active", m === "traveller");
  document.getElementById("btn-rider").classList.toggle("active",     m === "rider");
  document.getElementById("ui-traveller").classList.toggle("hidden",  m !== "traveller");
  document.getElementById("ui-rider").classList.toggle("hidden",      m !== "rider");
  if (m !== "rider" && riderOnline) { riderOnline = false; updateOnlineUI(); pushMyLoc(); }
  if (m === "rider") listenSearchRides();
  else { if (unsubSearch) { unsubSearch(); unsubSearch = null; } }
  updateMyMarker();
  pushMyLoc();
  toast(m === "rider" ? "🏍️ Rider mode. Go online to receive requests." : "🎒 Traveller mode. Book a ride anytime.");
}

// ── RIDER ONLINE ───────────────────────────────────────
function bindRiderOnline() {
  document.getElementById("btn-online").addEventListener("click", () => {
    if (mode !== "rider") return;
    riderOnline = !riderOnline;
    updateOnlineUI();
    pushMyLoc();
    toast(riderOnline ? "🟢 You're online! Waiting for ride requests…" : "⚫ You're offline.");
  });
}
function updateOnlineUI() {
  const btn = document.getElementById("btn-online");
  const txt = document.getElementById("online-txt");
  const bar = document.getElementById("rider-status-bar");
  btn.classList.toggle("online",  riderOnline);
  btn.classList.toggle("offline", !riderOnline);
  txt.textContent = riderOnline ? "Online — Tap to go offline" : "Go Online to Receive Rides";
  bar.classList.toggle("hidden", !riderOnline);
}

// ── BOOKING ────────────────────────────────────────────
function bindBooking() {
  document.getElementById("btn-book").addEventListener("click", doBook);
}

async function doBook() {
  if (!myLat) { toast("📍 Still getting your location. Please wait…"); return; }
  if (activeRide) { toast("You already have an active ride."); showPanel(); return; }

  // Destination
  const destInputVal = document.getElementById("dest-input").value.trim();
  if (!destInputVal && !destLat) { toast("Please enter a destination or tap the map."); return; }

  // If user typed something but didn't tap map, use text as label
  if (destInputVal && !destLat) {
    destLabel = destInputVal;
    // Geocode with Nominatim
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(destInputVal)}&limit=1`);
      const j = await r.json();
      if (j.length) {
        destLat = parseFloat(j[0].lat);
        destLng = parseFloat(j[0].lon);
        destLabel = j[0].display_name.split(",").slice(0,2).join(",");
        placeDestMarker(destLat, destLng);
      }
    } catch {}
    if (!destLat) { toast("Could not find that location. Try tapping the map instead."); return; }
  }

  const btn = document.getElementById("btn-book");
  btn.disabled = true; btn.textContent = "Booking…";

  try {
    const { db, collection, addDoc } = window._fb;
    const rideData = {
      // traveller
      tUid:      AUTH.uid,
      tName:     PROF.name,
      tPhone:    PROF.phone,
      tWa:       PROF.wa,
      tPhoto:    PROF.photoURL || "",
      tLat:      myLat,
      tLng:      myLng,
      // destination
      destLabel: destLabel || "",
      destLat:   destLat,
      destLng:   destLng,
      // rider (filled on accept)
      rUid:      null,
      rName:     null,
      rPhone:    null,
      rWa:       null,
      rPhoto:    null,
      rVehicle:  null,
      rLat:      null,
      rLng:      null,
      // status
      status:    "searching",
      fare:      0,
      payMethod: "cash",
      step:      0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const ref = await addDoc(collection(db, "rides"), rideData);
    activeRide = { id: ref.id, ...rideData };
    listenRide(ref.id);
    showPanel();
    showRp("rp-searching");
    toast("🔍 Looking for riders…");
  } catch (e) {
    toast("Error: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "🚀 Book Ride Now";
  }
}

// ── LISTEN ACTIVE RIDE ─────────────────────────────────
function listenRide(id) {
  if (unsubRide) { unsubRide(); unsubRide = null; }
  const { db, doc, onSnapshot } = window._fb;
  unsubRide = onSnapshot(doc(db, "rides", id), snap => {
    if (!snap.exists()) { activeRide = null; hidePanel(); return; }
    activeRide = { id: snap.id, ...snap.data() };
    handleRideSnap(activeRide);
  }, err => console.warn("ride listener:", err.message));
}

// On reload, find active ride
async function resumeRide() {
  const { db, collection, query, where, getDocs } = window._fb;
  const statuses = ["searching", "accepted", "arriving", "picked_up"];
  for (const s of statuses) {
    for (const [field, uid] of [["tUid", AUTH.uid], ["rUid", AUTH.uid]]) {
      try {
        const q = query(collection(db, "rides"), where(field, "==", uid), where("status", "==", s));
        const snap = await getDocs(q);
        if (!snap.empty) { listenRide(snap.docs[0].id); return; }
      } catch {}
    }
  }
}

// ── RIDE SNAPSHOT HANDLER ──────────────────────────────
function handleRideSnap(ride) {
  const amT = ride.tUid === AUTH.uid;
  const amR = ride.rUid === AUTH.uid;

  showPanel();

  if (ride.status === "searching") {
    if (amT) showRp("rp-searching");
    return;
  }
  if (ride.status === "cancelled") {
    activeRide = null;
    if (unsubRide) { unsubRide(); unsubRide = null; }
    hidePanel();
    clearRoute();
    removeMarker("_active");
    toast("Ride was cancelled.");
    return;
  }
  if (ride.status === "completed") {
    fillDone(ride, amT);
    showRp("rp-done");
    clearRoute();
    clearInterval(etaInt);
    return;
  }

  // Active: accepted / arriving / picked_up
  if (amT) {
    fillAccepted(ride);
    showRp("rp-accepted");
    setSteps(ride.step || 0);
    // Draw route rider → traveller
    if (ride.rLat && myLat && ["accepted","arriving"].includes(ride.status)) {
      drawRoute(ride.rLat, ride.rLng, myLat, myLng);
      fetchETA(ride.rLat, ride.rLng, myLat, myLng);
    }
    if (ride.rLat) upsertMarker("_active", { lat: ride.rLat, lng: ride.rLng, name: ride.rName, photoURL: ride.rPhoto, mode: "rider" });
  } else if (amR) {
    fillRiderActive(ride);
    showRp("rp-rider-active");
    // Draw route to traveller
    if (myLat && ride.tLat && ride.status !== "picked_up") {
      drawRoute(myLat, myLng, ride.tLat, ride.tLng);
    } else {
      clearRoute();
    }
    if (ride.tLat) upsertMarker("_active", { lat: ride.tLat, lng: ride.tLng, name: ride.tName, photoURL: ride.tPhoto, mode: "traveller" });
    // Update rider step button
    const stepBtn = document.getElementById("btn-rider-step");
    if (ride.step < 2) { stepBtn.textContent = "Mark Picked Up"; }
    else                { stepBtn.textContent = "Complete Ride ✓"; }
  }
}

// ── FILL PANELS ────────────────────────────────────────
function fillAccepted(ride) {
  setDP("acc-dp", ride.rPhoto, ride.rName);
  setTxt("acc-name",      ride.rName    || "—");
  setTxt("acc-vehicle",   ride.rVehicle || "");
  setTxt("acc-phone-txt", ride.rPhone ? "+91 " + ride.rPhone : "");
  setLink("acc-call", "tel:+91" + (ride.rPhone || ""));
  setLink("acc-wa",   waLink(ride.rWa || ride.rPhone, ride.rName, false));
}

function fillRiderActive(ride) {
  setDP("ra-dp", ride.tPhoto, ride.tName);
  setTxt("ra-name", ride.tName || "—");
  setTxt("ra-dest", ride.destLabel || "");
  const fare = computeFare(ride);
  setTxt("ra-fare", "₹" + fare);
  setLink("ra-call", "tel:+91" + (ride.tPhone || ""));
  setLink("ra-wa",   waLink(ride.tWa || ride.tPhone, ride.tName, true));
  const nav = document.getElementById("ra-nav");
  if (ride.tLat) nav.href = `https://www.google.com/maps/dir/?api=1&destination=${ride.tLat},${ride.tLng}`;
}

function fillDone(ride, amT) {
  const fare = computeFare(ride);
  setTxt("done-fare", "Fare: ₹" + fare);
  const upiPhone = amT ? ride.rWa : ride.tWa;
  const upiName  = amT ? ride.rName : ride.tName;
  const upiBox   = document.getElementById("upi-box");
  if (upiPhone) {
    upiBox.innerHTML = `Send ₹${fare} to <strong>+91${upiPhone}@upi</strong><br><a href="upi://pay?pa=${upiPhone}@upi&pn=${encodeURIComponent(upiName||"")}&am=${fare}&cu=INR" style="color:#00e5a0;font-weight:700">Open UPI App →</a>`;
  } else {
    upiBox.innerHTML = "Pay in cash to the rider.";
  }
}

// ── STEPS ──────────────────────────────────────────────
function setSteps(step) {
  // step 0=accepted, 1=arriving, 2=picked_up, 3=done
  const ids = ["st-0","st-1","st-2","st-3"];
  const lines = ["sl-0","sl-1","sl-2"];
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle("active", i === step);
    el.classList.toggle("done",   i < step);
  });
  lines.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("done", i < step);
  });
}

// ── LISTEN FOR SEARCHING RIDES (RIDER) ────────────────
function listenSearchRides() {
  if (unsubSearch) { unsubSearch(); unsubSearch = null; }
  const { db, collection, onSnapshot, query, where } = window._fb;
  const q = query(collection(db, "rides"), where("status", "==", "searching"));
  unsubSearch = onSnapshot(q, snap => {
    if (activeRide || !riderOnline) return;

    // Find a ride we haven't shown yet
    let newRide = null;
    snap.forEach(d => {
      if (d.data().tUid === AUTH.uid) return; // own booking
      if (pendingId === d.id) return;          // already showing
      if (newRide) return;
      newRide = { id: d.id, ...d.data() };
    });

    if (newRide) {
      pendingId = newRide.id;
      showRideRequest(newRide);
    }

    // Clear pending if it's gone
    if (pendingId && !snap.docs.find(d => d.id === pendingId)) {
      pendingId = null;
      if (!activeRide) hidePanel();
    }
  }, err => console.warn("search listener:", err.message));
}

function showRideRequest(ride) {
  const dist = (myLat && ride.tLat)
    ? haversine(myLat, myLng, ride.tLat, ride.tLng).toFixed(1) + " km"
    : "? km";
  const fare = computeFare(ride);

  setDP("req-dp", ride.tPhoto, ride.tName);
  setTxt("req-name", ride.tName  || "—");
  setTxt("req-dest", ride.destLabel || "—");
  setTxt("req-dist", "📍 " + dist + " away");
  setTxt("req-fare-box", "₹" + fare + " estimated fare");

  showPanel();
  showRp("rp-request");
  startTimer(30, ride.id);
}

function startTimer(secs, rideId) {
  clearInterval(timerInt);
  let t = secs;
  const arc = document.getElementById("timer-arc");
  const num = document.getElementById("timer-num");
  const circ = 125.6;
  num.textContent = t;
  arc.setAttribute("stroke-dashoffset", "0");
  timerInt = setInterval(() => {
    t--;
    num.textContent = t;
    arc.setAttribute("stroke-dashoffset", String(((secs - t) / secs) * circ));
    if (t <= 0) {
      clearInterval(timerInt);
      pendingId = null;
      if (!activeRide) hidePanel();
      toast("Request expired");
    }
  }, 1000);
}

// ACCEPT
document.getElementById("btn-accept").addEventListener("click", async () => {
  if (!pendingId) return;
  clearInterval(timerInt);
  const rideId = pendingId;
  pendingId = null;

  try {
    const { db, doc, updateDoc, getDoc } = window._fb;
    // Check it's still searching
    const snap = await getDoc(doc(db, "rides", rideId));
    if (!snap.exists() || snap.data().status !== "searching") {
      toast("Ride no longer available."); hidePanel(); return;
    }
    await updateDoc(doc(db, "rides", rideId), {
      rUid:     AUTH.uid,
      rName:    PROF.name,
      rPhone:   PROF.phone,
      rWa:      PROF.wa,
      rPhoto:   PROF.photoURL || "",
      rVehicle: PROF.vehicle || "",
      rLat:     myLat,
      rLng:     myLng,
      status:   "accepted",
      step:     0,
      updatedAt: Date.now()
    });
    activeRide = { id: rideId, ...snap.data(), status: "accepted", rUid: AUTH.uid };
    listenRide(rideId);
    toast("✅ Ride accepted!");
  } catch (e) {
    toast("Error: " + e.message);
    pendingId = null; hidePanel();
  }
});

// REJECT
document.getElementById("btn-reject").addEventListener("click", () => {
  clearInterval(timerInt);
  pendingId = null;
  hidePanel();
  toast("Request rejected.");
});

// ── RIDER STATUS BUTTON ────────────────────────────────
document.getElementById("btn-rider-step").addEventListener("click", async () => {
  if (!activeRide) return;
  const curStep = activeRide.step || 0;
  if (curStep < 2) {
    // Picked up
    await updateRide({ status: "arriving", step: 2, updatedAt: Date.now() });
    toast("Marked as picked up!");
  } else {
    // Complete
    const fare = computeFare(activeRide);
    await updateRide({ status: "completed", step: 3, fare, completedAt: Date.now(), updatedAt: Date.now() });
    const { db, doc, updateDoc } = window._fb;
    updateDoc(doc(db, "users", AUTH.uid), { totalRides: (PROF.totalRides || 0) + 1 }).catch(() => {});
    PROF.totalRides = (PROF.totalRides || 0) + 1;
    setTxt("p-rides", PROF.totalRides + " rides");
    toast("Ride completed! ✅");
  }
});

// ── CANCEL BUTTONS ─────────────────────────────────────
document.getElementById("btn-cancel-book").addEventListener("click",    doCancel);
document.getElementById("btn-cancel-ride-t").addEventListener("click",  doCancel);
document.getElementById("btn-cancel-ride-r").addEventListener("click",  doCancel);

async function doCancel() {
  if (!activeRide) { hidePanel(); return; }
  await updateRide({ status: "cancelled", updatedAt: Date.now() });
  activeRide = null;
  if (unsubRide) { unsubRide(); unsubRide = null; }
  hidePanel(); clearRoute(); removeMarker("_active");
  clearInterval(etaInt);
}

// ── UPDATE RIDE ────────────────────────────────────────
async function updateRide(data) {
  if (!activeRide) return;
  try {
    const { db, doc, updateDoc } = window._fb;
    await updateDoc(doc(db, "rides", activeRide.id), data);
  } catch (e) { toast("Error: " + e.message); }
}

async function updateRiderLocInRide() {
  if (!activeRide || !myLat) return;
  try {
    const { db, doc, updateDoc } = window._fb;
    await updateDoc(doc(db, "rides", activeRide.id), { rLat: myLat, rLng: myLng });
  } catch {}
}

// ── DONE & RATE ────────────────────────────────────────
document.getElementById("btn-done").addEventListener("click", () => {
  const ride = activeRide;
  activeRide = null;
  if (unsubRide) { unsubRide(); unsubRide = null; }
  hidePanel();
  clearRoute(); removeMarker("_active"); clearInterval(etaInt);
  if (ride) openRating(ride);
});

// ── PAYMENT CHIPS ──────────────────────────────────────
document.querySelectorAll(".pay-opt").forEach(c => {
  c.addEventListener("click", () => {
    document.querySelectorAll(".pay-opt").forEach(x => x.classList.remove("active"));
    c.classList.add("active");
    document.getElementById("upi-box").classList.toggle("hidden", c.dataset.pay !== "upi");
    if (activeRide) updateRide({ payMethod: c.dataset.pay }).catch(() => {});
  });
});

// ── RATING ─────────────────────────────────────────────
let _star = 0;
function openRating(ride) {
  _star = 0;
  const amT  = ride.tUid === AUTH.uid;
  const whom = amT ? ride.rName : ride.tName;
  setTxt("rate-whom", "Rating: " + (whom || "—"));
  document.querySelectorAll(".star").forEach(s => s.classList.remove("on"));
  document.getElementById("rate-comment").value = "";
  document.getElementById("rating-sheet").classList.remove("hidden");

  document.querySelectorAll(".star").forEach(s => {
    s.onclick = () => {
      _star = parseInt(s.dataset.v);
      document.querySelectorAll(".star").forEach(x => x.classList.toggle("on", parseInt(x.dataset.v) <= _star));
    };
  });

  document.getElementById("btn-rate-submit").onclick = async () => {
    if (!_star) { toast("Please select a star rating."); return; }
    const ratedUid = amT ? ride.rUid : ride.tUid;
    if (ratedUid) {
      try {
        const { db, doc, getDoc, updateDoc } = window._fb;
        const snap = await getDoc(doc(db, "users", ratedUid));
        if (snap.exists()) {
          const u = snap.data();
          await updateDoc(doc(db, "users", ratedUid), {
            rating:      (u.rating      || 0) + _star,
            ratingCount: (u.ratingCount || 0) + 1
          });
        }
      } catch {}
    }
    document.getElementById("rating-sheet").classList.add("hidden");
    toast("⭐ Thanks for rating!");
    loadHistory();
  };
  document.getElementById("btn-rate-skip").onclick = () => {
    document.getElementById("rating-sheet").classList.add("hidden");
    loadHistory();
  };
}

// ── ROUTE ──────────────────────────────────────────────
async function drawRoute(lat1, lng1, lat2, lng2) {
  clearRoute();
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;
    const res  = await fetch(url, { timeout: 5000 });
    const data = await res.json();
    if (!data.routes?.[0]) return;
    const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    routePoly = L.polyline(coords, { color: "#00e5a0", weight: 4, opacity: .8 }).addTo(map);
    map.fitBounds(routePoly.getBounds(), { padding: [50, 50] });
  } catch {}
}

function clearRoute() {
  if (routePoly) { map.removeLayer(routePoly); routePoly = null; }
}

async function fetchETA(lat1, lng1, lat2, lng2) {
  clearInterval(etaInt);
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=false`;
    const res  = await fetch(url);
    const data = await res.json();
    const secs = data.routes?.[0]?.duration;
    if (!secs) return;
    let rem = Math.round(secs);
    updateETA(rem);
    etaInt = setInterval(() => { rem--; if (rem <= 0) { clearInterval(etaInt); return; } updateETA(rem); }, 1000);
  } catch {}
}

function updateETA(sec) {
  const el = document.getElementById("acc-eta");
  if (!el) return;
  el.textContent = sec < 60 ? sec + "s" : Math.ceil(sec / 60) + " min";
}

// ── HISTORY ────────────────────────────────────────────
async function loadHistory() {
  const { db, collection, query, where, getDocs } = window._fb;
  const list = document.getElementById("history-list");
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const combined = new Map();
  try {
    for (const [field, uid] of [["tUid", AUTH.uid], ["rUid", AUTH.uid]]) {
      const q = query(collection(db, "rides"), where(field, "==", uid));
      const snap = await getDocs(q);
      snap.forEach(d => {
        const data = d.data();
        if ((data.createdAt || 0) < cutoff) return; // skip old
        combined.set(d.id, { id: d.id, ...data });
      });
    }
  } catch {}

  if (!combined.size) { list.innerHTML = `<div class="empty">No rides yet</div>`; return; }

  const sorted = [...combined.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  list.innerHTML = sorted.map(r => {
    const amT    = r.tUid === AUTH.uid;
    const role   = amT ? "Traveller" : "Rider";
    const other  = amT ? r.rName : r.tName;
    const dest   = r.destLabel || "—";
    const fare   = r.fare ? "₹" + r.fare : "—";
    const chipCls = r.status === "completed" ? "hc-done" : r.status === "cancelled" ? "hc-cancel" : "hc-active";
    const dt     = new Date(r.createdAt || 0).toLocaleDateString();
    return `<div class="hcard">
      <div class="hcard-left">
        <h4>${esc(dest)}</h4>
        <p>${role} · ${esc(other || "—")} · ${dt}</p>
      </div>
      <div class="hcard-right">
        <span class="hchip ${chipCls}">${r.status}</span><br/>
        <span class="hfare">${fare}</span>
      </div>
    </div>`;
  }).join("");
}

// ── 24H CLEANUP ────────────────────────────────────────
async function cleanup24h() {
  const { db, collection, query, where, getDocs, doc, writeBatch } = window._fb;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  try {
    const batch = writeBatch(db);
    let count = 0;
    for (const field of ["tUid", "rUid"]) {
      const q = query(collection(db, "rides"), where(field, "==", AUTH.uid));
      const snap = await getDocs(q);
      snap.forEach(d => {
        if ((d.data().createdAt || 0) < cutoff) {
          batch.delete(doc(db, "rides", d.id)); count++;
        }
      });
    }
    if (count > 0) await batch.commit();
  } catch {}
  // Also clean stale location (>10 min)
  try {
    const locCutoff = Date.now() - 10 * 60 * 1000;
    const { db: db2, doc: doc2, getDoc, updateDoc } = window._fb;
    const snap = await getDoc(doc2(db2, "locations", AUTH.uid));
    if (snap.exists() && (snap.data().ts || 0) < locCutoff) {
      await updateDoc(doc2(db2, "locations", AUTH.uid), { visible: false });
    }
  } catch {}
}

// ── TABS ───────────────────────────────────────────────
function bindTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-content").forEach(v => {
        v.classList.remove("active"); v.classList.add("hidden");
      });
      const target = document.getElementById("tab-" + t);
      if (target) { target.classList.remove("hidden"); target.classList.add("active"); }
      if (t === "map" && map) setTimeout(() => map.invalidateSize(), 80);
      if (t === "rides") loadHistory();
    });
  });
  // Notif btn → nav profile
  document.getElementById("btn-nav-profile")?.addEventListener("click", () => {
    document.querySelector('[data-tab="profile"]').click();
  });
  // Resume active ride after slight delay
  setTimeout(resumeRide, 2000);
}

// ── PROFILE ────────────────────────────────────────────
function fillProfileTab() {
  if (!PROF) return;
  const dp = document.getElementById("nav-dp");
  if (PROF.photoURL) { dp.src = PROF.photoURL; }
  setImg("p-dp", PROF.photoURL, PROF.name);
  setTxt("p-name",  PROF.name  || "");
  setTxt("p-email", PROF.email || "");
  setTxt("p-phone", "+91 " + (PROF.phone || "—"));
  setTxt("p-wa",    "+91 " + (PROF.wa    || "—"));
  setTxt("p-rides", (PROF.totalRides || 0) + " rides");
  const avg = PROF.ratingCount > 0 ? (PROF.rating / PROF.ratingCount).toFixed(1) + " ★" : "New";
  setTxt("p-rating", avg);
  const vrow = document.getElementById("p-vehicle-row");
  if (PROF.vehicle) {
    setTxt("p-vehicle", PROF.vehicle + (PROF.vno ? " · " + PROF.vno : ""));
    vrow.style.display = "flex";
  } else {
    vrow.style.display = "none";
  }
}

function bindEditProfile() {
  document.getElementById("btn-edit").addEventListener("click", () => {
    document.getElementById("e-name").value    = PROF.name    || "";
    document.getElementById("e-phone").value   = PROF.phone   || "";
    document.getElementById("e-wa").value      = PROF.wa      || "";
    document.getElementById("e-vehicle").value = PROF.vehicle || "";
    document.getElementById("e-vno").value     = PROF.vno     || "";
    document.getElementById("edit-sheet").classList.remove("hidden");
  });
  document.getElementById("btn-edit-cancel").addEventListener("click", () => {
    document.getElementById("edit-sheet").classList.add("hidden");
  });
  document.getElementById("btn-edit-save").addEventListener("click", async () => {
    const updates = {
      name:    val("e-name"),
      phone:   val("e-phone"),
      wa:      val("e-wa") || val("e-phone"),
      vehicle: val("e-vehicle"),
      vno:     val("e-vno")
    };
    if (!updates.name || !updates.phone) { toast("Name and phone required."); return; }
    try {
      const { db, doc, updateDoc } = window._fb;
      await updateDoc(doc(db, "users", AUTH.uid), updates);
      PROF = { ...PROF, ...updates };
      fillProfileTab();
      document.getElementById("edit-sheet").classList.add("hidden");
      pushMyLoc();
      toast("✅ Profile updated!");
    } catch (e) { toast("Error: " + e.message); }
  });
}

function bindSignOut() {
  document.getElementById("btn-signout").addEventListener("click", async () => {
    killAll();
    try {
      const { db, doc, updateDoc } = window._fb;
      await updateDoc(doc(db, "locations", AUTH.uid), { visible: false });
    } catch {}
    const { auth, signOut } = window._fb;
    await signOut(auth);
  });
}

// ── PANEL HELPERS ──────────────────────────────────────
function showPanel() { document.getElementById("ride-panel").classList.remove("hidden"); }
function hidePanel()  { document.getElementById("ride-panel").classList.add("hidden"); document.querySelectorAll(".rp").forEach(el => el.classList.add("hidden")); }
function showRp(id)   { document.querySelectorAll(".rp").forEach(el => el.classList.add("hidden")); document.getElementById(id).classList.remove("hidden"); }
function bindPanel() {
  // Panel bindings already done above per button
}

// ── UTILS ──────────────────────────────────────────────
function showScreen(id) {
  ["screen-loading","screen-auth","screen-setup","screen-app"].forEach(s => {
    document.getElementById(s)?.classList.toggle("hidden", s !== "screen-" + id);
  });
}
function val(id)    { return document.getElementById(id)?.value.trim() || ""; }
function setTxt(id, t) { const el = document.getElementById(id); if (el) el.textContent = t; }
function setLink(id, href) { const el = document.getElementById(id); if (el && href) el.href = href; }
function setDP(id, url, name) {
  const el = document.getElementById(id); if (!el) return;
  if (url) { el.src = url; el.alt = name || ""; } else { el.removeAttribute("src"); el.alt = (name||"?")[0]; }
}
function setImg(id, url, name) { setDP(id, url, name); }
function showErr(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function haversine(a, b, c, d) {
  const R=6371,dA=(c-a)*Math.PI/180,dB=(d-b)*Math.PI/180;
  const x=Math.sin(dA/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dB/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function computeFare(ride) {
  if (ride.tLat && ride.destLat) {
    const km = haversine(ride.tLat, ride.tLng, ride.destLat, ride.destLng);
    return Math.max(10, Math.round(10 + km * 5));
  }
  return 10;
}
function waLink(phone, name, isRider) {
  if (!phone) return "#";
  const msg = isRider
    ? `Hi ${name||""}, I'm your TuiGo rider. I'm on my way!`
    : `Hi ${name||""}, I'm waiting for my TuiGo ride!`;
  return `https://wa.me/91${phone}?text=${encodeURIComponent(msg)}`;
}

function killAll() {
  if (geoWatch) navigator.geolocation.clearWatch(geoWatch);
  clearInterval(locTick); clearInterval(etaInt); clearInterval(timerInt);
  [unsubRide, unsubSearch, unsubNearby].forEach(u => u?.());
  unsubRide = unsubSearch = unsubNearby = null;
  if (map) { map.remove(); map = null; }
  Object.keys(MARKS).forEach(k => delete MARKS[k]);
  activeRide = null; pendingId = null; riderOnline = false;
}
