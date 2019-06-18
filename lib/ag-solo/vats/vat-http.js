import harden from '@agoric/harden';

import { addReplHandler } from './repl';

// This vat contains the HTTP request handler.

function build(E, D) {
  let commandDevice;
  let provisioner;
  const homeObjects = {};

  let handler = {};
  let canvasState;

  return {
    setCommandDevice(d, ROLES) {
      commandDevice = d;
      handler = {
        getCanvasState() {
          return {
            type: 'updateCanvas',
            state: canvasState,
          };
        },
      };
      if (ROLES.client) {
        addReplHandler(handler, E, homeObjects, msg =>
          D(commandDevice).sendBroadcast(msg),
        );
      }
      if (ROLES.controller) {
        handler.pleaseProvision = obj => {
          const { nickname, pubkey } = obj;
          return E(provisioner).pleaseProvision(nickname, pubkey);
        };
      }
    },

    setProvisioner(p) {
      provisioner = p;
    },

    setPresences(ps) {
      Object.assign(homeObjects, ps);
    },

    updateCanvas(canvas) {
      canvasState = canvas;
      if (!commandDevice) {
        return;
      }
      D(commandDevice).sendBroadcast({
        type: 'updateCanvas',
        state: canvasState,
      });
    },

    // devices.command invokes our inbound() because we passed to
    // registerInboundHandler()
    inbound(count, obj) {
      console.log(`vat-http.inbound (from browser) ${count}`, obj);
      const p = Promise.resolve(handler[obj.type](obj));
      p.then(
        res => D(commandDevice).sendResponse(count, false, harden(res)),
        rej => D(commandDevice).sendResponse(count, true, harden(rej)),
      );
    },
  };
}

export default function setup(syscall, state, helpers) {
  return helpers.makeLiveSlots(
    syscall,
    state,
    (E, D) => harden(build(E, D)),
    helpers.vatID,
  );
}
