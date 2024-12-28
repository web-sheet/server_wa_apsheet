import qrcode from 'qrcode-terminal'; 
import pkg from 'whatsapp-web.js';
import express from 'express';
import path from 'path';
import http from 'http';
import { Server } from 'socket.io'; 
import admin from 'firebase-admin';
import serviceAccount from './config/wa-info-firebase-adminsdk-qi1ve-38eb1b94ec.json' assert { type: 'json' };

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://wa-info-default-rtdb.firebaseio.com/"
});

const { Client, LocalAuth } = pkg;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'] 
});

const PORT = process.env.PORT || 5000; 
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

app.use(express.json());
app.use(express.static('public')); 

const clients = []; // Array to hold multiple client instances

async function initializeClient(clientId) {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId, dataPath: "Data" }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    client.on('qr', qr => {
        qrcode.generate(qr, { small: true });
        io.emit('qr', { clientId, qr });  
    });

    client.on('ready', async () => {
        console.log(`${clientId} is ready!`);
        const userNumber = client.info.wid.user; 
        const timestamp = new Date().toLocaleString(); 

        await admin.database().ref(`users/${userNumber}`).set({
            number: userNumber,
            time: timestamp,
            status: 'online'
        });

        io.emit('userLoggedIn', { number: userNumber, time: timestamp });
    });

    client.on('message_create', message => {
        console.log(message.body);
    });

    client.on('disconnected', async (reason) => {
        console.log(`${clientId} was logged out:`, reason);
        const userNumber = client.info.wid.user; 

        await admin.database().ref(`users/${userNumber}`).update({
            status: 'offline'
        });

        io.emit('userDisconnected', { number: userNumber });
        await client.logout(); 
    });

    await client.initialize(); 
    clients.push(client); // Store the client instance
}

app.post('/initializeClient', async (req, res) => {
    const { clientId } = req.body;
    await initializeClient(clientId);
    res.status(200).send({ result: `Client ${clientId} initialized` });
});




app.get('/clients', async (req, res) => {
    try {
        const snapshot = await admin.database().ref('users').once('value');
        const clients = snapshot.val() || {};
        res.status(200).send(clients);
    } catch (error) {
        console.error('Error retrieving clients:', error);
        res.status(500).send({ error: 'Failed to retrieve clients' });
    }
});




app.get('/userInfo/:number', async (req, res) => {
    const { number } = req.params;
    try {
        const snapshot = await admin.database().ref(`users/${number}`).once('value');
        const userInfo = snapshot.val();
        res.status(200).send(userInfo);
    } catch (error) {
        console.error('Error retrieving user info:', error);
        res.status(500).send({ error: 'Failed to retrieve user info' });
    }
});



app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


 
app.post('/sendMessage', async (req, res) => {
    const { sender, to, message } = req.body;

    // Validate input
    if (!sender || !to || !message) {
        return res.status(400).send({ error: 'Sender, recipient, and message are required.' });
    }

    // Log input values
    console.log('Sender:', sender, 'Recipient:', to, 'Message:', message);

    // Find the client instance based on the sender ID
    const client = clients.find(c => c.info.wid.user === sender);
    
    if (!client) {
        console.log('Client not found for sender:', sender);
        return res.status(404).send({ error: 'Client not found.' });
    }

    // Format the recipient's number
    const formattedRecipient = `${to}@c.us`;

    try {
        // Send the message
        await client.sendMessage(formattedRecipient, message);
        res.status(200).send({ result: 'Message sent successfully.' });
    } catch (error) {
        console.error('Error sending message:', JSON.stringify(error, null, 2));
        res.status(500).send({ error: 'Failed to send message.' });
    }
});

