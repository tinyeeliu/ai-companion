# AI Companion - Local App

An application to run locally on a computer to provide access to local resources via REST, MCP, and Websocket capability.

TBD = To be desgined by AI agent.

## Name & Description

AI Companion for desktop. Provide local services to empower AI agents locally and on cloud.

## Design Philosophy

- Simple elegant UX
- Self recover
- Visible status
- Laymen can use and maintain without technical knowledge

## Archiecture

- Server: NodeJS with BUN runtime
- Frontend: Svelte SPA
- Package: Tauri (Mac+Windows)
- Database: "bun:sqlite"
- File: Local folder "data" within app space.

## Installer

Tauri need to an installer or dmg that easily install on Mac (Apple Silicon).
When app installed, start local BUN server at port 38888 as a service.
User will see the web interface served with 38888. User will not know it's web app and no other browser capability.

## Features

### Whatsapp 

Baileys:
https://baileys.wiki/

Using Baileys as core, we connect to WhatsApp via web socket to control as a user.

This keep the Whatsapp connectivity close to the user away from cloud server resources.

Keep track of user sessions locally within the app. There will be no database.

Data in "data/whatsapp/{subfolder}"

REST API:
- Send message
- Set webwhook

User can add a whatsapp connection via QR code. 
User can add multiple connection.
User can disable/enable connection.
User can delete connection.
User can see live status and metrics, such as uptime and incoming/outgoing messages count.

Can send whastapp message.
Can set webhook, and willl forward new messages to the webhook.


## UI

Create a Canvas with /canvas skill after implement phase 1.

No login page fo now. Control panel type of UI but for laymen.

TBD.

### Phase 1

Server and Whatspp REST API.
Installable MAC APP.

### Phase 2

UI interface.

Human confirm Canvas UI before implementation.

