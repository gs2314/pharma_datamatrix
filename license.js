"use strict";

// License gate for the renderer. Talks to Electron's main process (which in
// turn talks to the user's PHP license server) via the preload IPC bridge.
//
// In web / dev mode (`window.electronAPI` undefined), the license gate is a
// no-op — so development can happen in a plain browser without needing the
// license server.

window.License = (function () {
  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);

  async function hwid() {
    if (!isElectron) return "web-dev-hwid";
    return await window.electronAPI.license.hwid();
  }

  async function debugMode() {
    // Web dev mode is implicitly debug.
    if (!isElectron) return true;
    return await window.electronAPI.license.debugMode();
  }

  async function status() {
    // Web / dev: always OK, no license required.
    if (!isElectron) {
      return {
        ok: true, debug: true,
        cached: { license_number: "DEBUG", owner: { company: "DEBUG MODE — NO LICENSE" } },
      };
    }
    return await window.electronAPI.license.status();
  }

  async function activate(licenseNumber) {
    if (!isElectron) return { ok: true, cached: { license_number: licenseNumber } };
    return await window.electronAPI.license.activate(licenseNumber);
  }

  async function deactivate() {
    if (!isElectron) return { ok: true };
    return await window.electronAPI.license.deactivate();
  }

  function reasonLabel(reason) {
    switch (reason) {
      case "no_license_installed":    return "No license installed on this workstation yet.";
      case "empty_license_number":    return "Please enter your license key.";
      case "not_found":               return "This license key was not found.";
      case "revoked":                 return "This license has been revoked. Contact the vendor.";
      case "hwid_mismatch":           return "This license is bound to a different machine.";
      case "expired":                 return "This license has expired.";
      case "rejected_by_server":      return "The license server rejected this key.";
      case "network_error":           return "Could not reach the license server. Check internet connection.";
      case "offline_and_grace_expired": return "Offline grace period expired. Connect to the internet.";
      default:                        return reason ? "License error: " + reason : "Unknown license error.";
    }
  }

  return { isElectron, hwid, debugMode, status, activate, deactivate, reasonLabel };
})();
