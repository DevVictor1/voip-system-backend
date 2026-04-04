const express = require('express');
const router = express.Router();

// Create user
router.post('/create-user', (req, res) => {
    res.send('Create user');
});

// Get users
router.get('/users', (req, res) => {
    res.send('Get users');
});

module.exports = router;