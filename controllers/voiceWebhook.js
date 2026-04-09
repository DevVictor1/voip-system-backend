exports.outgoingCall = (req, res) => {
  console.log('ðŸ”¥ OUTGOING CALLED');

  res.writeHead(200, { 'Content-Type': 'text/xml' });

  res.end(`
    <Response>
      <Say>Connecting your call, please wait.</Say>
      <Dial>${process.env.DEFAULT_DIAL_TO}</Dial>
    </Response>
  `);
};

exports.incomingCall = (req, res) => {
  console.log('âœ… INCOMING CALL HIT');

  res.writeHead(200, { 'Content-Type': 'text/xml' });

  res.end(`
    <Response>
      <Say>Welcome. Please wait while we connect your call.</Say>
      <Dial>${process.env.DEFAULT_DIAL_TO}</Dial>
    </Response>
  `);
};
