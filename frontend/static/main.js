"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
let audioEncoder = null;
let videoEncoder = null;
let serverConnection = null;
let peerConnections = {};
let localUuid, localDisplayName, localStream;
const WS_PORT = 8443;
const PEER_CONNECTION_CFG = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
    ],
};
const VIDEO_STREAM_WIDTH = 1280;
const VIDEO_STREAM_HEIGHT = 720;
const VIDEO_STREAM_FRAME_RATE = 30;
const CONSTRAINTS = {
    video: {
        width: { ideal: VIDEO_STREAM_WIDTH, max: VIDEO_STREAM_WIDTH },
        height: { ideal: VIDEO_STREAM_HEIGHT, max: VIDEO_STREAM_HEIGHT },
        frameRate: { ideal: VIDEO_STREAM_FRAME_RATE, max: VIDEO_STREAM_FRAME_RATE },
    },
    audio: true,
};
const VIDEO_ENCODER_CFG = {
    codec: 'vp8',
    width: VIDEO_STREAM_WIDTH,
    height: VIDEO_STREAM_HEIGHT,
    framerate: VIDEO_STREAM_FRAME_RATE,
    bitrate: 1000000,
    latencyMode: 'realtime',
};
const VIDEO_DECODER_CFG = {
    codec: VIDEO_ENCODER_CFG.codec,
    codedWidth: VIDEO_ENCODER_CFG.width,
    codedHeight: VIDEO_ENCODER_CFG.height,
    hardwareAcceleration: "no-preference",
};
const AUDIO_ENCODER_CFG = {
    codec: 'opus',
    numberOfChannels: 1,
    sampleRate: 48000,
    bitrate: 64000,
};
const AUDIO_DECODER_CFG = {
    codec: AUDIO_ENCODER_CFG.codec,
    numberOfChannels: AUDIO_ENCODER_CFG.numberOfChannels,
    sampleRate: AUDIO_ENCODER_CFG.sampleRate,
};
function initializeCodecs(stream) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!('VideoEncoder' in window))
            return;
        const videoTrack = stream.getVideoTracks()[0];
        const audioTrack = stream.getAudioTracks()[0];
        const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
        const videoReader = videoProcessor.readable.getReader();
        videoEncoder = new VideoEncoder({
            output: (encodedChunk) => {
                const data = new ArrayBuffer(encodedChunk.byteLength);
                const view = new Uint8Array(data);
                encodedChunk.copyTo(view);
                Object.values(peerConnections).forEach((peer) => {
                    var _a;
                    if (((_a = peer.dataChannel) === null || _a === void 0 ? void 0 : _a.readyState) === 'open') {
                        peer.dataChannel.send(JSON.stringify({
                            type: encodedChunk.type,
                            timestamp: encodedChunk.timestamp,
                            duration: encodedChunk.duration,
                        }));
                        peer.dataChannel.send(data);
                    }
                });
            },
            error: (e) => console.error(e),
        });
        videoEncoder.configure(VIDEO_ENCODER_CFG);
        const processVideoFrames = () => __awaiter(this, void 0, void 0, function* () {
            try {
                while (true) {
                    const { value: frame, done } = yield videoReader.read();
                    if (done)
                        break;
                    if ((videoEncoder === null || videoEncoder === void 0 ? void 0 : videoEncoder.state) === 'configured') {
                        videoEncoder === null || videoEncoder === void 0 ? void 0 : videoEncoder.encode(frame);
                    }
                    frame.close();
                }
            }
            catch (e) {
                console.error('Error processing frames:', e);
            }
        });
        processVideoFrames();
        if (audioTrack && 'AudioEncoder' in window) {
            console.log(audioTrack.getSettings());
            const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
            const audioReader = audioProcessor.readable.getReader();
            audioEncoder = new AudioEncoder({
                output: (encodedChunk) => {
                    const data = new ArrayBuffer(encodedChunk.byteLength);
                    const view = new Uint8Array(data);
                    encodedChunk.copyTo(view);
                    Object.values(peerConnections).forEach(peer => {
                        var _a;
                        if (((_a = peer.dataChannel) === null || _a === void 0 ? void 0 : _a.readyState) === 'open') {
                            peer.dataChannel.send(JSON.stringify({
                                type: 'audio',
                                timestamp: encodedChunk.timestamp,
                                duration: encodedChunk.duration,
                            }));
                            peer.dataChannel.send(data);
                        }
                    });
                },
                error: (e) => console.error('Audio Encoder Error:', e),
            });
            audioEncoder.configure(AUDIO_ENCODER_CFG);
            const processAudioFrames = () => __awaiter(this, void 0, void 0, function* () {
                try {
                    while (true) {
                        const { value: frame, done } = yield audioReader.read();
                        if (done)
                            break;
                        if ((audioEncoder === null || audioEncoder === void 0 ? void 0 : audioEncoder.state) === 'configured' && frame) {
                            try {
                                audioEncoder.encode(frame);
                            }
                            catch (e) {
                                console.error('Error encoding audio frame:', e);
                            }
                        }
                        frame.close();
                    }
                }
                catch (e) {
                    console.error('Error processing audio frames:', e);
                }
            });
            processAudioFrames();
        }
    });
}
function start() {
    return __awaiter(this, void 0, void 0, function* () {
        localUuid = createUUID();
        const urlParams = new URLSearchParams(window.location.search);
        localDisplayName = urlParams.get("displayName") || localUuid;
        const labelContainer = document.getElementById("localVideoContainer");
        if (labelContainer)
            labelContainer.appendChild(makeLabel(localDisplayName));
        try {
            localStream = yield getMediaStream();
            const localVideo = document.getElementById("localVideo");
            localVideo.srcObject = localStream;
            yield initializeCodecs(localStream);
            serverConnection = new WebSocket(`wss://${location.hostname}:${WS_PORT}/ws/`);
            serverConnection.onmessage = (msg) => gotMessageFromServer(msg);
            serverConnection.onopen = () => {
                serverConnection.send(JSON.stringify({ displayName: localDisplayName, uuid: localUuid, dest: "all" }));
            };
        }
        catch (error) {
            errorHandler(error);
        }
    });
}
function getMediaStream() {
    return __awaiter(this, void 0, void 0, function* () {
        if (navigator.mediaDevices.getDisplayMedia) {
            return yield navigator.mediaDevices.getDisplayMedia(CONSTRAINTS);
        }
        else if (navigator.mediaDevices.getUserMedia) {
            return yield navigator.mediaDevices.getUserMedia(CONSTRAINTS);
        }
        else {
            alert("Your browser does not support getDisplayMedia or getUserMedia API");
            throw new Error("Unsupported media API");
        }
    });
}
function setUpPeer(peerUuid, displayName, initCall = false) {
    const peerConnection = {
        displayName,
        pc: new RTCPeerConnection(PEER_CONNECTION_CFG),
    };
    const dataChannel = peerConnection.pc.createDataChannel('media-channel');
    peerConnection.dataChannel = dataChannel;
    let metadata;
    let videoWritable;
    let videoStreamGenerator;
    let audioStreamGenerator;
    let audioWritable;
    dataChannel.onopen = () => __awaiter(this, void 0, void 0, function* () {
        if (!('VideoDecoder' in window))
            return;
        peerConnection.videoDecoder = new VideoDecoder({
            output: (frame) => {
                if (!videoStreamGenerator) {
                    videoStreamGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
                    videoWritable = videoStreamGenerator.writable.getWriter();
                    const stream = new MediaStream([videoStreamGenerator]);
                    const vidElement = document.querySelector(`#remoteVideo_${peerUuid} video`);
                    if (vidElement) {
                        vidElement.srcObject = stream;
                        vidElement.play().catch(e => console.error('Error playing video:', e));
                    }
                }
                videoWritable.write(frame);
            },
            error: (e) => console.error(e),
        });
        peerConnection.videoDecoder.configure(VIDEO_DECODER_CFG);
        if ('AudioDecoder' in window) {
            peerConnection.audioDecoder = new AudioDecoder({
                output: (audioData) => __awaiter(this, void 0, void 0, function* () {
                    if (!audioStreamGenerator) {
                        audioStreamGenerator = new MediaStreamTrackGenerator({ kind: 'audio' });
                        audioWritable = audioStreamGenerator.writable.getWriter();
                        const stream = new MediaStream([audioStreamGenerator]);
                        const audioElement = document.querySelector(`#remoteAudio_${peerUuid}`);
                        if (audioElement) {
                            audioElement.srcObject = stream;
                            audioElement.play().catch(e => console.error('Error playing audio:', e));
                        }
                    }
                    audioWritable.write(audioData);
                }),
                error: (e) => console.error('Audio decoder error:', e),
            });
            peerConnection.audioDecoder.configure(AUDIO_DECODER_CFG);
        }
    });
    dataChannel.onmessage = (event) => __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        if (typeof event.data === 'string') {
            metadata = JSON.parse(event.data);
        }
        else if (metadata.type === 'video') {
            const chunk = new EncodedVideoChunk({
                type: metadata.type,
                timestamp: metadata.timestamp,
                duration: metadata.duration,
                data: event.data,
            });
            if (((_a = peerConnection.videoDecoder) === null || _a === void 0 ? void 0 : _a.state) === 'configured') {
                peerConnection.videoDecoder.decode(chunk);
            }
        }
        else if (metadata.type === 'audio') {
            const chunk = new EncodedAudioChunk({
                type: 'key',
                timestamp: metadata.timestamp,
                duration: metadata.duration,
                data: event.data,
            });
            if (((_b = peerConnection.audioDecoder) === null || _b === void 0 ? void 0 : _b.state) === 'configured') {
                peerConnection.audioDecoder.decode(chunk);
            }
        }
    });
    peerConnection.pc.ontrack = (event) => {
        if (event.track.kind == 'video') {
            gotRemoteStream(event, peerUuid);
        }
    };
    peerConnection.pc.onicecandidate = (event) => gotIceCandidate(event, peerUuid);
    peerConnection.pc.oniceconnectionstatechange = () => checkPeerDisconnect(peerUuid);
    localStream.getTracks().forEach(track => {
        peerConnection.pc.addTrack(track, localStream);
    });
    peerConnections[peerUuid] = peerConnection;
    if (initCall) {
        peerConnection.pc.createOffer()
            .then((description) => createdDescription(description, peerUuid))
            .catch(errorHandler);
    }
}
function gotMessageFromServer(message) {
    const signal = JSON.parse(message.data);
    const peerUuid = signal.uuid;
    if (peerUuid === localUuid || (signal.dest !== localUuid && signal.dest !== "all"))
        return;
    if (signal.type === "peer-disconnect") {
        handlePeerDisconnect(peerUuid);
        return;
    }
    if (signal.displayName && signal.dest === "all") {
        setUpPeer(peerUuid, signal.displayName);
        serverConnection.send(JSON.stringify({ displayName: localDisplayName, uuid: localUuid, dest: peerUuid }));
    }
    else if (signal.displayName && signal.dest === localUuid) {
        setUpPeer(peerUuid, signal.displayName, true);
    }
    else if (signal.sdp) {
        handleSdpSignal(signal, peerUuid);
    }
    else if (signal.ice) {
        handleIceCandidate(signal, peerUuid);
    }
}
function handleSdpSignal(signal, peerUuid) {
    peerConnections[peerUuid].pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
        .then(() => {
        if (signal.sdp.type === "offer") {
            peerConnections[peerUuid].pc.createAnswer()
                .then((description) => createdDescription(description, peerUuid))
                .catch(errorHandler);
        }
    })
        .catch(errorHandler);
}
function handleIceCandidate(signal, peerUuid) {
    peerConnections[peerUuid].pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
}
function handlePeerDisconnect(peerUuid) {
    var _a;
    console.log(`Peer ${peerUuid} disconnected`);
    delete peerConnections[peerUuid];
    const vidElement = document.getElementById(`remoteVideo_${peerUuid}`);
    if (vidElement)
        (_a = document.getElementById("videos")) === null || _a === void 0 ? void 0 : _a.removeChild(vidElement);
    updateLayout();
}
function gotRemoteStream(event, peerUuid) {
    var _a;
    const vidElement = document.createElement("video");
    vidElement.setAttribute("autoplay", "");
    vidElement.setAttribute("muted", "");
    vidElement.srcObject = event.streams[0];
    const vidContainer = document.createElement("div");
    vidContainer.id = `remoteVideo_${peerUuid}`;
    vidContainer.className = "videoContainer";
    vidContainer.appendChild(vidElement);
    vidContainer.appendChild(makeLabel(peerConnections[peerUuid].displayName));
    (_a = document.getElementById("videos")) === null || _a === void 0 ? void 0 : _a.appendChild(vidContainer);
    updateLayout();
}
function checkPeerDisconnect(peerUuid) {
    const state = peerConnections[peerUuid].pc.iceConnectionState;
    if (["failed", "closed", "disconnected"].includes(state)) {
        handlePeerDisconnect(peerUuid);
    }
}
function gotIceCandidate(event, peerUuid) {
    if (event.candidate) {
        serverConnection.send(JSON.stringify({ ice: event.candidate, uuid: localUuid, dest: peerUuid }));
    }
}
function createdDescription(description, peerUuid) {
    peerConnections[peerUuid].pc.setLocalDescription(description)
        .then(() => {
        serverConnection.send(JSON.stringify({
            sdp: peerConnections[peerUuid].pc.localDescription,
            uuid: localUuid,
            dest: peerUuid,
        }));
    })
        .catch(errorHandler);
}
function updateLayout() {
    const numVideos = Object.keys(peerConnections).length + 1;
    const rowHeight = numVideos > 1 && numVideos <= 4 ? "48vh" : numVideos > 4 ? "32vh" : "98vh";
    const colWidth = numVideos > 1 && numVideos <= 4 ? "48vw" : numVideos > 4 ? "32vw" : "98vw";
    document.documentElement.style.setProperty("--rowHeight", rowHeight);
    document.documentElement.style.setProperty("--colWidth", colWidth);
}
function makeLabel(label) {
    const vidLabel = document.createElement("div");
    vidLabel.textContent = label;
    vidLabel.className = "videoLabel";
    return vidLabel;
}
function createUUID() {
    return ([1e7, -1e3, -4e3, -8e3, -1e11].join('')).replace(/[018]/g, (c) => (parseInt(c, 16) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (parseInt(c, 16) / 4)))).toString(16));
}
function errorHandler(error) {
    console.error(error);
}
window.addEventListener("beforeunload", () => {
    if ((videoEncoder === null || videoEncoder === void 0 ? void 0 : videoEncoder.state) !== 'closed') {
        videoEncoder === null || videoEncoder === void 0 ? void 0 : videoEncoder.close();
    }
    if ((audioEncoder === null || audioEncoder === void 0 ? void 0 : audioEncoder.state) !== 'closed') {
        audioEncoder === null || audioEncoder === void 0 ? void 0 : audioEncoder.close();
    }
    Object.values(peerConnections).forEach(peer => {
        var _a, _b, _c, _d;
        if (((_a = peer.videoDecoder) === null || _a === void 0 ? void 0 : _a.state) !== 'closed') {
            (_b = peer.videoDecoder) === null || _b === void 0 ? void 0 : _b.close();
        }
        if (((_c = peer.audioDecoder) === null || _c === void 0 ? void 0 : _c.state) !== 'closed') {
            (_d = peer.audioDecoder) === null || _d === void 0 ? void 0 : _d.close();
        }
        if (peer.dataChannel) {
            peer.dataChannel.close();
        }
    });
    serverConnection === null || serverConnection === void 0 ? void 0 : serverConnection.send(JSON.stringify({ type: "peer-disconnect", uuid: localUuid }));
});
