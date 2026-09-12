package com.sharethis.signaling;

import org.springframework.web.socket.WebSocketSession;

import java.util.Locale;

/** One connected browser tab. */
public final class Peer {

    public enum Mode {
        IDLE, SEND, RECEIVE, BUSY;

        /** Parses the lowercase wire value ("receive"), or returns null if unknown. */
        static Mode fromWire(String value) {
            if (value == null) return null;
            try {
                return valueOf(value.toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
    }

    private final String id;
    private final String name;
    private final WebSocketSession session;
    private volatile Mode mode = Mode.IDLE;

    Peer(String id, String name, WebSocketSession session) {
        this.id = id;
        this.name = name;
        this.session = session;
    }

    public String id() { return id; }
    public String name() { return name; }
    public WebSocketSession session() { return session; }
    public Mode mode() { return mode; }
    void mode(Mode mode) { this.mode = mode; }
}
