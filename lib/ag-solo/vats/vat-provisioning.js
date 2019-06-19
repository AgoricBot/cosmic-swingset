import harden from '@agoric/harden';

// This vat contains the controller-side provisioning service. To enable local
// testing, it is loaded by both the controller and other ag-solo vat machines.

function build(E) {
  let demo;
  let comms;

  async function register(d, c) {
    demo = d;
    comms = c;
  }

  async function pleaseProvision(nickname, pubkey) {
    const chainBundle = E(demo).getChainBundle(nickname);
    const fetch = harden({
      getChainBundle() {
        return chainBundle;
      },
    });

    // Add an egress for the pubkey.
    const INDEX = 1;
    await E(comms).addEgress(pubkey, INDEX, fetch);
    return { ingressIndex: INDEX };
  }

  return harden({ register, pleaseProvision });
}

export default function setup(syscall, state, helpers) {
  return helpers.makeLiveSlots(syscall, state, E => build(E), helpers.vatID);
}
