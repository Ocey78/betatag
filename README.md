# Beta Tag Server

Lightweight room/matchmaking server for Beta Tag.

## Render

Deploy this repository as a Render Web Service.

- Runtime: Node
- Build command: `npm ci`
- Start command: `npm start`
- Health check: `/status`
- WebSocket endpoint: `/ws`

After deployment:

- Status: `https://YOUR-SERVICE.onrender.com/status`
- Game socket: `wss://YOUR-SERVICE.onrender.com/ws`

## Protocol

Client messages:

- `{"type":"profile","name":"NANO","color":{"r":0.2,"g":0.5,"b":1}}`
- `{"type":"create_room"}`
- `{"type":"join_room","code":"ABCD"}`
- `{"type":"join_random"}`
- `{"type":"leave_room"}`
- `{"type":"transform","seq":1,"head":POSE,"leftHand":POSE,"rightHand":POSE}`
- `{"type":"tag_state","tagged":true}`
- `{"type":"cosmetics","hat":"HAT_ID","face":"FACE_ID","badge":"BADGE_ID"}`
- `{"type":"ping","t":123}`

A POSE is:

`{"position":{"x":0,"y":0,"z":0},"rotation":{"x":0,"y":0,"z":0,"w":1}}`

The server keeps rooms only in RAM. Render restarts will clear active rooms.


Cosmetics are included in room snapshots and `player_joined` messages, and updates are broadcast live with `type: "cosmetics"`.
