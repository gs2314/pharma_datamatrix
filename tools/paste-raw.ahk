; paste-raw.ahk — AutoHotkey v2
;
; Keystroke-synthesis fallback for pharmacies whose gov-system field
; strips 0x1D on Ctrl+V paste. Compile with Ahk2Exe to paste-raw.exe
; and drop it in the Windows Startup folder alongside the server.
;
; Usage: in Pharmacy Parker, press Enter on a row (the raw string
; with GS bytes is placed on the clipboard). Click into the gov
; system's scan field and press F12 instead of Ctrl+V. Each character
; is typed as an HID keystroke; every U+001D becomes Ctrl+] (the
; canonical keystroke for the GS separator, identical to what the
; barcode scanner emits).

#Requires AutoHotkey v2.0

F12:: {
    text := A_Clipboard
    if (text = "") {
        TrayTip "Pharmacy Parker", "Clipboard is empty", 1
        return
    }
    Loop Parse, text {
        ch := A_LoopField
        if (ch = Chr(0x1D)) {
            Send "^]"
        } else if (ch = "`t") {
            Send "{Tab}"
        } else if (ch = "`n" || ch = "`r") {
            Send "{Enter}"
        } else {
            SendText ch
        }
    }
}
