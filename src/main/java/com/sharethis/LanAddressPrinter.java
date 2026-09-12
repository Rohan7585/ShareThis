package com.sharethis;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.context.WebServerInitializedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** Logs the LAN URLs other devices can use to open the app. */
@Component
public class LanAddressPrinter {

    private static final Logger log = LoggerFactory.getLogger(LanAddressPrinter.class);

    /** NetworkInterface.isVirtual() only covers sub-interfaces, so also filter common virtual adapters by name. */
    private static final List<String> VIRTUAL_HINTS = List.of(
            "virtual", "vethernet", "hyper-v", "vmware", "vbox", "virtualbox", "docker", "wsl",
            "loopback", "pseudo", "tap-", "tunnel", "vpn");

    @EventListener
    public void onServerStarted(WebServerInitializedEvent event) {
        int port = event.getWebServer().getPort();
        List<String> urls = new ArrayList<>();
        try {
            for (NetworkInterface nic : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (nic.isLoopback() || !nic.isUp() || nic.isVirtual() || looksVirtual(nic)) continue;
                for (InetAddress addr : Collections.list(nic.getInetAddresses())) {
                    if (addr instanceof Inet4Address && addr.isSiteLocalAddress()) {
                        urls.add("http://" + addr.getHostAddress() + ":" + port + " (" + nic.getDisplayName() + ")");
                    }
                }
            }
        } catch (SocketException e) {
            log.warn("Could not list network interfaces: {}", e.getMessage());
        }

        if (urls.isEmpty()) {
            log.warn("ShareThis is running on port {}, but no LAN address was found. Is Wi-Fi connected?", port);
        } else {
            log.info("ShareThis is running. Open one of these on other devices on the same network:");
            urls.forEach(url -> log.info("  {}", url));
        }
    }

    private static boolean looksVirtual(NetworkInterface nic) {
        String text = (nic.getName() + " " + nic.getDisplayName()).toLowerCase(Locale.ROOT);
        return VIRTUAL_HINTS.stream().anyMatch(text::contains);
    }
}
