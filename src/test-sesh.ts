import sdk from '@tencent-ai/agent-sdk';

async function main() {
  console.log('Creating session with includePartialMessages=true...');
  const session = await sdk.unstable_v2_createSession({
    model: 'hy3-preview-agent-ioa',
    permissionMode: 'bypassPermissions',
    maxTurns: 3,
    includePartialMessages: true,
  });
  console.log('Session created, sending...');
  await session.send('say: hello in 3 words');
  console.log('Sent, streaming...');

  let count = 0;
  try {
    for await (const msg of session.stream()) {
      count++;
      const t = msg.type;
      if (t === 'stream_event') {
        const evt = (msg as any).event;
        console.log(`  #${count} ${t}.${evt.type} idx=${evt.index}`);
      } else if (t === 'assistant') {
        console.log(`  #${count} ${t} blocks=${(msg as any).message.content.length}`);
      } else {
        console.log(`  #${count} ${t}`);
      }
    }
  } catch (e: any) {
    console.error('STREAM ERROR:', e.message);
  }
  console.log(`Done. Total messages: ${count}`);
  await session.close();
}
main().catch(e => console.error('FATAL:', e.message));
