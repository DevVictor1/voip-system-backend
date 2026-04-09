const VoiceResponse = require('twilio').twiml.VoiceResponse;

// STEP 1: IVR menu
exports.ivrMenu = (req, res) => {
  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    numDigits: 1,
    action: '/api/calls/handle-key',
    method: 'POST',
  });

  gather.say('Welcome to Kaylad. Press 1 for Sales. Press 2 for Support.');

  twiml.say('No input received. Goodbye.');

  res.type('text/xml');
  res.send(twiml.toString());
};

// STEP 2: Handle key press
exports.handleKey = (req, res) => {
  const twiml = new VoiceResponse();

  const digit = req.body.Digits;

  console.log('User pressed:', digit);

  if (digit === '1') {
    twiml.say('Connecting to Sales');
    twiml.dial('+2349167688961'); // Sales number
  } else if (digit === '2') {
    twiml.say('Connecting to Support');
    twiml.dial('+2349167688961'); // Support number (change later)
  } else {
    twiml.say('Invalid option. Goodbye.');
  }

  res.type('text/xml');
  res.send(twiml.toString());
};
