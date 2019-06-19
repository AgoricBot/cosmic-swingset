import path from 'path';
import fetch from 'node-fetch';
import { execFile } from 'child_process';
import djson from 'deterministic-json';
import { createHash } from 'crypto';
import connect from 'lotion-connect';

const HELPER = 'ag-cosmos-helper';

export async function connectToChain(
  basedir,
  GCI,
  rpcAddresses,
  myAddr,
  inbound,
  chainID,
  setUserState,
) {
  // Each time we read our mailbox from the chain's state, and each time we
  // send an outbound message to the chain, we shell out to a one-shot copy
  // of 'ag-cosmos-helper', the swingset-flavored cosmos-sdk CLI tool.

  // We originally thought we could use the tool's "rest-server" mode, leave
  // it running for the duration of our process, but it turns out that the
  // rest-server cannot sign transactions (that ability was removed as a
  // security concern in https://github.com/cosmos/cosmos-sdk/issues/3641)

  // A better approach I'm hopeful we can achieve is an FFI binding to the
  // same golang code that powers ag-cosmos-helper, so we can call the
  // query/tx functions directly without the overhead of spawning a
  // subprocess and encoding everything as strings over stdio.

  // the 'ag-cosmos-helper' tool in our repo is built by 'make install' and
  // put into the user's $GOPATH/bin . That's a bit intrusive, ideally it
  // would live in the build tree along with bin/ag-solo . But for now we
  // assume that 'ag-cosmos-helper' is on $PATH somewhere.

  // Shuffle our rpcAddresses, to help distribute load.
  // Modern version of Fisher-Yates shuffle algorithm (in-place).
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const x = a[i];
      a[i] = a[j];
      a[j] = x;
    }
  }
  shuffle(rpcAddresses);

  const helperDir = path.join(basedir, 'ag-cosmos-helper-statedir');

  const cancels = {};

  async function retryRpcAddr(tryOnce) {
    for (;;) {
      const randomRpcAddr =
        rpcAddresses[Math.floor(Math.random() * rpcAddresses.length)];

      // tryOnce will either throw if cancelled (which rejects this promise),
      const ret = await tryOnce(randomRpcAddr);
      if (ret !== undefined) {
        // Or returns non-undefined, which we should resolve.
        return ret;
      }

      // It was undefined, so wait, then retry.
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  function singletonHelper(name, args, parseReturn, stdin) {
    // We already have one running, so cancel it.
    if (cancels[name]) {
      cancels[name]();
    }

    let cancelled = false;
    cancels[name] = () => {
      delete cancels[name];
      cancelled = true;
    };

    return retryHelper(args, parseReturn, stdin, () => {
      if (cancelled) {
        throw `cancelled`;
      }
    });
  }

  function retryHelper(
    args,
    parseReturn,
    stdin,
    throwIfCancelled = () => undefined,
  ) {
    return retryRpcAddr(async rpcAddr => {
      throwIfCancelled();

      const fullArgs = [
        ...args,
        '--chain-id',
        chainID,
        '--output',
        'json',
        '--node',
        `tcp://${rpcAddr}`,
        '--home',
        helperDir,
      ];
      console.log(HELPER, ...fullArgs);
      let ret;
      try {
        ret = await new Promise((resolve, reject) => {
          const proc = execFile(HELPER, fullArgs, (error, stdout, stderr) => {
            if (error) {
              return reject(error);
            }
            resolve({ stdout, stderr });
          });
          if (stdin) {
            proc.stdin.write(stdin);
            proc.stdin.end();
          }
        });
      } catch (e) {
        console.log(` failed exec of:`, HELPER, ...fullArgs);
      }

      throwIfCancelled();

      if (ret) {
        try {
          return await parseReturn(ret);
        } catch (e) {
          console.log(`Failed to parse return:`, e);
        }
      }
    });
  }

  const getStorage = path =>
    singletonHelper(
      `getStorage${path}`,
      ['query', 'swingset', 'storage', path],
      ret => {
        const { stdout, stderr } = ret;
        process.stderr.write(stderr);
        if (stdout.startsWith('could not find')) {
          process.stdout.write(` helper said: ${stdout}`);
          return '{}';
        }
        try {
          // Try to parse the stdout.
          return JSON.parse(JSON.parse(stdout).value);
        } catch (e) {
          console.log(` failed to parse output:`, e);
        }
        return undefined;
      },
    );

  const getMailbox = () =>
    singletonHelper(
      'getMailbox',
      ['query', 'swingset', 'mailbox', myAddr],
      ret => {
        const { stdout, stderr } = ret;
        console.error(stderr);
        console.log(` helper said: ${stdout}`);
        try {
          // Try to parse the stdout.
          return JSON.parse(JSON.parse(JSON.parse(stdout).value));
        } catch (e) {
          console.log(` failed to parse output:`, e);
        }
        return undefined;
      },
    );

  const getGenesis = () =>
    retryRpcAddr(async rpcAddr => {
      const rpcURL = `http://${rpcAddr}`;
      try {
        const res = await fetch(`${rpcURL}/genesis`);
        const json = await res.json();
        return json.result.genesis;
      } catch (e) {
        console.log(`Error fetching ${rpcURL}:`, e);
      }
    });

  /*
  getGenesis().then(g => console.log(`genesis is`, g));
  getGenesis().then(g => {
    const gci = createHash('sha256').update(djson.stringify(g)).digest('hex');
    console.log(`computed GCI is ${gci}`);
  });
  */

  // TODO: decide on a single place to perform the light-client checks. The
  // 'tendermint' package can do this (instantiate Tendermint() with a
  // known-valid starting state, containing {header,validators,commit}, which
  // can be fetched by RPC, and maybe the validators can be extracted from
  // the genesis block, which we can compare against the GCI). The
  // 'ag-cosmos-helper' tool might do it. We need one subscription-type thing
  // to tell us that a new block exists, then we can use a different
  // query-type tool to retrieve the outbox, but we want to know that the
  // outbox is correctly traced to the block header, and that the block
  // header is a legitimate descendant of our previously-validated state.

  // we use a small piece (connect-by-address.js) of lotion-connect to do
  // this; we could get away with fewer dependencies by rewriting just that
  // part.

  // we could also do connect(undefined, { genesis, nodes })
  const c = await connect(
    GCI,
    { nodes: rpcAddresses.map(addr => `ws://${addr}`) },
  );

  // TODO: another way to make this cheaper would be to extract the apphash
  // from the received block, and only check the mailbox if it changes.
  // That's more coarse than checking for only our own slot, but better than
  // hitting the rest-server on every single block.

  let doSetUserState;
  if (setUserState) {
    doSetUserState = async () => {
      // Notify our store listeners of this object's contents.
      const userState = await getStorage('user');
      console.log(`got ${GCI} userState`, userState);
      setUserState(GCI, JSON.parse(userState));
    };
  } else {
    doSetUserState = async () => undefined;
  }

  c.lightClient.on('update', async _a => {
    console.log(`new block on ${GCI}, fetching mailbox`);
    const { outbox, ack } = await getMailbox();
    await inbound(GCI, outbox, ack);
    await doSetUserState();
  });

  function deliver(newMessages, acknum) {
    console.log(`delivering to chain`, GCI, newMessages, acknum);

    // TODO: combine peer and submitter in the message format (i.e. remove
    // the extra 'myAddr' after 'tx swingset deliver'). All messages from
    // solo vats are "from" the signer, and messages relayed from another
    // chain will have other data to demonstrate which chain it comes from

    // TODO: remove this JSON.stringify([newMessages, acknum]): change
    // 'deliverMailboxReq' to have more structure than a single string, and
    // have the CLI handle variable args better

    const args = [
      'tx',
      'swingset',
      'deliver',
      myAddr,
      JSON.stringify([newMessages, acknum]),
      '--from',
      'ag-solo',
      '--yes',
    ];
    const password = 'mmmmmmmm';
    return retryHelper(
      args,
      ret => {
        const { stderr, stdout } = ret;
        console.error(stderr);
        console.log(` helper said: ${stdout}`);
        // TODO: parse the helper output (JSON), we want 'code' to be 0. If
        // not, look at .raw_log (also JSON) at .message . I think if we send
        // two messages back-to-back too quickly, the second one uses the
        // same seqnum as the first, so it will be rejected by the
        // signature-checking auth/ante handler on the chain. We need to
        // queue our deliver() calls and not allow one to proceed until the
        // others have finished. (unlike singletonHelper above, we do not
        // want to cancel anything: each deliver() should be allowed to run
        // to completion).
        return true;
      },
      `${password}\n`,
    );
  }

  return { deliver, doSetUserState };
}
