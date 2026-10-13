# ShareThis

A browser-based SHAREit/Xender for your local network. Devices on the same Wi-Fi (or the same
hotspot) send files directly to each other through WebRTC data channels. The Spring Boot server
only introduces devices to each other and relays small signaling messages. File bytes never reach
the server and are never stored on it.

## How it works

- **Signaling server** (Spring Boot, WebSocket at `/ws`): tracks who's online, who is in Download
  mode, and relays transfer requests plus the WebRTC offer/answer/ICE messages.
- **WebRTC `RTCDataChannel`**: carries the file bytes browser-to-browser across the router.
- The frontend is plain HTML/CSS/JS in `src/main/resources/static`. It has no external dependencies,
  so it also works on a hotspot with no internet access.

## Run it

Requires Java 17+ and Maven (or use the Maven wrapper if you add one).

Double-click `start.bat`, or run it from a terminal. It checks that the port is free and then
starts the server with Maven. To use a different port, pass it as an argument, e.g. `start.bat 9000`.

You can also start it directly:

```powershell
mvn spring-boot:run
```

The default port is 8765 (set in `src/main/resources/application.properties`). On startup the log
lists the LAN URLs, for example:

```
ShareThis is running. Open one of these on other devices on the same network:
  http://192.168.1.10:8765 (Intel(R) Wi-Fi 6 AX201 160MHz)
```

## Connect other devices

1. Connect each phone or laptop to the same Wi-Fi (or hotspot) as the server.
2. Open the URL from the startup log, e.g. `http://192.168.1.10:8765`.
3. On the receiving device tap **Download**. On the sending device tap **Upload**, choose files, then
   tap the receiver's name. The receiver taps **Accept**, and the transfer runs directly between the
   two devices.
4. The two devices stay connected until either one taps **Disconnect**. The sender can tap
   **Send more files** as often as they like. Each new file shows up on the receiver with
   **Accept** / **Decline** buttons, plus **Accept all** / **Decline all** for everything waiting.
   Accepted files are sent one after another, in the order they were accepted.

## Troubleshooting

**The page doesn't load on other devices**
- The first time Java listens on a port, Windows shows a firewall prompt. Allow it on **Private**
  networks. If you dismissed the prompt, allow inbound TCP 8765, for example (from an admin PowerShell):
  `New-NetFirewallRule -DisplayName "ShareThis 8765" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Allow -Profile Private`
- The Wi-Fi network profile is set to **Public**, which blocks inbound connections. Check it with
  `Get-NetConnectionProfile`, then switch it under Settings → Network & internet → Wi-Fi → (your
  network) → Network profile type → Private.
- Wrong IP: use the address of the adapter that's connected to the Wi-Fi (see the startup log or
  `ipconfig`). It can change when you reconnect.

**Devices see each other but the transfer never connects**
- Guest and office Wi-Fi networks often use *client isolation* (AP isolation), which stops devices
  from talking to each other directly. Use a home network or a phone hotspot, or turn isolation off
  in the router settings.
- To avoid exposing local IPs to web pages, Chrome hides them behind random `.local` mDNS names,
  and some networks fail to resolve those names. As a test, open
  `chrome://flags/#enable-webrtc-hide-local-ips-with-mdns` on **both** devices, set it to
  *Disabled*, and relaunch Chrome.
- After connecting, the transfer screen shows the connection type. "host ↔ host" means a direct
  LAN connection.

**Very large files**
- Received files are held in memory until you tap Save, so files of several GB can exhaust memory
  on phones. Streaming to disk is a planned improvement.

## Not included (yet)

Authentication, persistence, TURN relays, room codes / QR pairing, streaming to disk, HTTPS.
Everyone who can reach the server is treated as one room.
