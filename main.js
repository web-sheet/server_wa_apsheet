import qrcode from 'qrcode-terminal'; 
import pkg from 'whatsapp-web.js';
import express from 'express';
import path from 'path';
import http from 'http';
import { Server } from 'socket.io'; 
import admin from 'firebase-admin';
import serviceAccount from './config/wa-info-firebase-adminsdk-qi1ve-6230afb3f0.json' assert { type: 'json' };

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

const clients = [];   

async function initializeClient(clientId) {
    const client = new Client({
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });

    let qrCodeEnabled = false; // Flag to control QR code generation

    client.on('qr', qr => {
        if (qrCodeEnabled) { // Only generate QR code if enabled
            qrcode.generate(qr, { small: true });
            io.emit('qr', { clientId, qr });  
        }
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

    client.on('disconnected', async (reason) => {
        console.log(`${clientId} was logged out:`, reason);       
        const userNumber = client.info.wid.user; 

        await admin.database().ref(`users/${userNumber}`).update({
            status: 'offline'
        });
        io.emit('userDisconnected', { number: userNumber });           
        
        qrCodeEnabled = false;            
            const index = clients.findIndex(c => c.info.wid.user === userNumber);
            if (index !== -1) {
                clients.splice(index, 1);
            }


    });

    qrCodeEnabled = true;  
    await client.initialize(); 
    clients.push(client); 
}

app.post('/initializeClient', async (req, res) => {
    const { clientId } = req.body; 
    const existingClient = clients.find(c => c.info.wid.user === clientId);
    if (existingClient) {
        await existingClient.destroy();  
        const index = clients.indexOf(existingClient);
        clients.splice(index, 1);  
    }

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

app.post('/logout/:clientId', async (req, res) => {
    const { clientId } = req.params;

    
    const client = clients.find(c => c.info.wid.user === clientId);

    if (!client) {
        return res.status(404).send({ error: 'Client not found.' });
    }

    try {
        // await client.destroy();  
        console.log(`${clientId} has been logged out successfully.`);        
        await admin.database().ref(`users/${clientId}`).update({
            status: 'offline'
        });

        io.emit('userDisconnected', { number: clientId });
        res.status(200).send({ result: `${clientId} logged out successfully.` });
    } catch (error) {
        console.error(`Error logging out client ${clientId}:`, error);
        res.status(500).send({ error: 'Failed to log out client.' });
    }
});



app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


 
app.post('/sendMessage', async (req, res) => {
    const { sender, to, message } = req.body;

    if (!sender || !to || !message) {
        return res.status(400).send({ error: 'Sender, recipient, and message are required.' });
    }

    console.log('Sender:', sender, 'Recipient:', to, 'Message:', message);
 
    const client = clients.find(c => c.info.wid.user === sender);
    
    if (!client) {
        console.log('Client not found for sender:', sender);
        return res.status(404).send({ error: 'Client not found.' });
    }

    const formattedRecipient = `${to}@c.us`;

    try { 
        await client.sendMessage(formattedRecipient, message);
        res.status(200).send({ result: 'Message sent successfully.' });
    } catch (error) {
        console.error('Error sending message:', JSON.stringify(error, null, 2));
        res.status(500).send({ error: 'Failed to send message.' });
    }
});


app.delete('/deleteClient/:clientId', async (req, res) => {
    const { clientId } = req.params;

    // Find the client in the clients array
    const clientIndex = clients.findIndex(c => c.info.wid.user === clientId);
    if (clientIndex === -1) {
        return res.status(404).send({ error: 'Client not found.' });
    }

    try {
        // Destroy the client instance
        await clients[clientIndex].destroy();
        console.log(`${clientId} has been deleted successfully.`);

        // Remove the client from the Firebase database
        await admin.database().ref(`users/${clientId}`).remove();

        // Remove the client from the clients array
        clients.splice(clientIndex, 1);

        res.status(200).send({ result: `${clientId} deleted successfully.` });
    } catch (error) {
        console.error(`Error deleting client ${clientId}:`, error);
        res.status(500).send({ error: 'Failed to delete client.' });
    }
});
