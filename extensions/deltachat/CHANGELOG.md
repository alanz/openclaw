# Delta.Chat Extension Changelog

## 2026.2.3 (2026-02-03)

### Added

- **QR Code Pairing Feature**: Added pairing functionality to generate QR codes for pairing Delta.Chat clients
  - New `src/pairing.ts` module with QR code generation logic
  - ASCII QR code visualization for terminal output
  - File output support for QR code data
  - Integration with `openclaw pairing generate --channel deltachat` command
  - Updated README with pairing documentation

### Files Added

- `src/pairing.ts` - QR code generation module
- `PAIRING_IMPLEMENTATION.md` - Detailed implementation documentation

### Files Modified

- `src/pairing.ts` - Added QR code generation module
- `README.md` - Added pairing command documentation and examples
- `CHANGELOG.md` - This file

## 2026.2.2 (2026-02-02)

### Added

- Initial Delta.Chat channel plugin implementation
- Incoming message handling via `IncomingMsg` event
- Support for `miscSendTextMessage()` for sending messages
- DM security policies (pairing, allowlist, open)
- Group security policies (allowlist, open)
- Chatmail server support
- Multiple account support
- TypeScript types and error handling
- Follows OpenClaw extension conventions
- Pattern based on matrix and bluebubbles extensions

### Architecture

- Uses `@deltachat/jsonrpc-client` to communicate with Delta.Chat core
- Event-driven message handling
- Security-first approach with configurable policies
- Proper separation of concerns (monitor, send, accounts, etc.)

### Files Created

- `index.ts` - Plugin registration
- `package.json` - Dependencies and metadata
- `openclaw.plugin.json` - Plugin configuration
- `src/channel.ts` - Channel plugin definition
- `src/monitor.ts` - Incoming message handler
- `src/send.ts` - Message sending utilities
- `src/outbound.ts` - Outbound handler
- `src/accounts.ts` - Account management
- `src/config-schema.ts` - Configuration validation
- `src/types.ts` - TypeScript types
- `src/actions.ts` - Message actions
- `src/onboarding.ts` - Setup commands
- `src/probe.ts` - Health checks
- `src/targets.ts` - Target resolution
- `src/runtime.ts` - Runtime management
- `README.md` - Documentation
- `CHANGELOG.md` - This file

### Known Limitations

- Reactions not supported (Delta.Chat limitation)
- Threads not supported (Delta.Chat limitation)
- Message editing not supported
- Message unsending not supported
- Reply support is basic (via context)

### Future Enhancements

- Media attachment support
- Better error handling and recovery
- Message reactions via emoji
- Group management features
- Typing indicators
- Read receipts
- Message history queries
