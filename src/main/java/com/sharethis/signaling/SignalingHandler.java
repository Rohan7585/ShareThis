package com.sharethis.signaling;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Signaling server: tracks who is online and relays small JSON messages between them.
 * File bytes never pass through here; they travel over a WebRTC data channel.
 */
@Component
public class SignalingHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(SignalingHandler.class);

    /** Message types forwarded verbatim (minus "to", plus "from"/"fromName") to another peer. */
    private static final Set<String> RELAYED_TYPES =
            Set.of("transfer-request", "transfer-response", "signal", "cancel");

    private static final List<String> ADJECTIVES = List.of(
            "Blue", "Calm", "Brave", "Swift", "Happy", "Quiet", "Bright", "Clever", "Gentle", "Lucky",
            "Bold", "Sunny", "Misty", "Wild", "Jolly", "Proud", "Silver", "Golden", "Rapid", "Cosmic");
    private static final List<String> ANIMALS = List.of(
            "Fox", "Otter", "Panda", "Tiger", "Falcon", "Koala", "Wolf", "Dolphin", "Owl", "Lynx",
            "Hawk", "Bear", "Rabbit", "Penguin", "Moose", "Badger", "Heron", "Gecko", "Bison", "Seal");

    private static final int SEND_TIME_LIMIT_MS = 10_000;
    private static final int SEND_BUFFER_LIMIT_BYTES = 512 * 1024;

    private final ObjectMapper mapper;
    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    /** WebSocket session id -> peer id. */
    private final Map<String, String> peerIdBySession = new ConcurrentHashMap<>();
    private final Set<String> usedNames = ConcurrentHashMap.newKeySet();

    public SignalingHandler(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession rawSession) {
        // The decorator serialises concurrent sends (e.g. two broadcasts at once) on one session.
        WebSocketSession session = new ConcurrentWebSocketSessionDecorator(
                rawSession, SEND_TIME_LIMIT_MS, SEND_BUFFER_LIMIT_BYTES);

        String name = claimName();
        Peer peer;
        do {
            peer = new Peer(UUID.randomUUID().toString().substring(0, 8), name, session);
        } while (peers.putIfAbsent(peer.id(), peer) != null);
        peerIdBySession.put(rawSession.getId(), peer.id());

        log.info("{} ({}) connected from {}", peer.name(), peer.id(), rawSession.getRemoteAddress());
        send(peer, mapper.createObjectNode()
                .put("type", "welcome")
                .put("id", peer.id())
                .put("name", peer.name()));
        send(peer, receiverListFor(peer));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        Peer sender = peerFor(session);
        if (sender == null) return;

        JsonNode msg;
        try {
            msg = mapper.readTree(message.getPayload());
        } catch (IOException e) {
            log.debug("Ignoring malformed message from {}", sender.id());
            return;
        }
        if (!(msg instanceof ObjectNode obj)) return;

        String type = obj.path("type").asText("");
        if ("set-mode".equals(type)) {
            Peer.Mode mode = Peer.Mode.fromWire(obj.path("mode").asText(null));
            if (mode != null && mode != sender.mode()) {
                sender.mode(mode);
                log.info("{} is now {}", sender.name(), mode.name().toLowerCase());
                broadcastReceiverLists();
            }
        } else if (RELAYED_TYPES.contains(type)) {
            relay(sender, type, obj);
        }
    }

    private void relay(Peer sender, String type, ObjectNode msg) {
        String targetId = msg.path("to").asText("");
        Peer target = peers.get(targetId);
        if (target == null) {
            send(sender, mapper.createObjectNode().put("type", "peer-left").put("id", targetId));
            return;
        }

        // A sender's list can be momentarily stale; don't bother a device that stopped receiving.
        if ("transfer-request".equals(type) && target.mode() != Peer.Mode.RECEIVE) {
            send(sender, mapper.createObjectNode()
                    .put("type", "transfer-response")
                    .put("accepted", false)
                    .put("reason", "not-receiving")
                    .put("from", target.id())
                    .put("fromName", target.name()));
            return;
        }

        msg.remove("to");
        msg.put("from", sender.id());
        msg.put("fromName", sender.name());
        send(target, msg);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String peerId = peerIdBySession.remove(session.getId());
        Peer peer = peerId == null ? null : peers.remove(peerId);
        if (peer == null) return;
        usedNames.remove(peer.name());
        log.info("{} ({}) disconnected", peer.name(), peer.id());

        ObjectNode left = mapper.createObjectNode().put("type", "peer-left").put("id", peer.id());
        peers.values().forEach(p -> send(p, left));
        broadcastReceiverLists();
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.debug("Transport error on {}: {}", session.getId(), exception.getMessage());
    }

    // ---- helpers ----

    private Peer peerFor(WebSocketSession session) {
        String id = peerIdBySession.get(session.getId());
        return id == null ? null : peers.get(id);
    }

    /** Every device gets its own list: other devices currently in "receive" mode. */
    private void broadcastReceiverLists() {
        peers.values().forEach(p -> send(p, receiverListFor(p)));
    }

    private ObjectNode receiverListFor(Peer viewer) {
        ObjectNode msg = mapper.createObjectNode().put("type", "peers");
        ArrayNode list = msg.putArray("peers");
        peers.values().stream()
                .filter(p -> p != viewer && p.mode() == Peer.Mode.RECEIVE)
                .forEach(p -> list.addObject().put("id", p.id()).put("name", p.name()));
        return msg;
    }

    private String claimName() {
        ThreadLocalRandom rnd = ThreadLocalRandom.current();
        for (int attempt = 0; attempt < 50; attempt++) {
            String name = ADJECTIVES.get(rnd.nextInt(ADJECTIVES.size())) + " "
                    + ANIMALS.get(rnd.nextInt(ANIMALS.size()));
            if (usedNames.add(name)) return name;
        }
        // 400 combinations; with lots of devices fall back to a numbered name.
        for (int n = 2; ; n++) {
            String name = ADJECTIVES.get(rnd.nextInt(ADJECTIVES.size())) + " "
                    + ANIMALS.get(rnd.nextInt(ANIMALS.size())) + " " + n;
            if (usedNames.add(name)) return name;
        }
    }

    private void send(Peer peer, JsonNode msg) {
        WebSocketSession session = peer.session();
        if (!session.isOpen()) return;
        try {
            session.sendMessage(new TextMessage(mapper.writeValueAsString(msg)));
        } catch (IOException | IllegalStateException e) {
            // Includes SessionLimitExceededException from the decorator; the close callback cleans up.
            log.debug("Could not send to {}: {}", peer.id(), e.getMessage());
        }
    }
}
