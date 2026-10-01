import express from 'express';
import Database from 'better-sqlite3';

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  return res.status(200).send({'message': 'SHIPTIVITY API. Read documentation to see API docs'});
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database('./clients.db');

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Id can only be integer.',
      },
    };
  }
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Cannot find client with that id.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  if (Number.isNaN(priority)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid priority provided.',
      'long_message': 'Priority can only be positive integer.',
      },
    };
  }
  return {
    valid: true,
  }
}

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get('/api/v1/clients', (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
    const clients = db.prepare('select * from clients where status = ?').all(status);
    return res.status(200).send(clients);
  }
  const statement = db.prepare('select * from clients');
  const clients = statement.all();
  return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }
  return res.status(200).send(db.prepare('select * from clients where id = ?').get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }

  let { status, priority } = req.body;
  let clients = db.prepare('select * from clients').all();
  const client = clients.find(client => client.id === id);

  /* ---------- Update code below ----------*/

  const oldStatus = client.status;
  const oldPriority = client.priority;
  const statusProvided = status !== undefined && status !== null && status !== '';
  const priorityProvided = priority !== undefined && priority !== null && priority !== '';

  if (!statusProvided && !priorityProvided) {
    return res.status(200).send(clients);
  }

  if (statusProvided) {
    if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
  } else {
    status = oldStatus;
  }

  if (priorityProvided) {
    priority = parseInt(priority, 10);
    const { valid: priorityValid, messageObj: priorityMessageObj } = validatePriority(priority);
    if (!priorityValid) {
      return res.status(400).send(priorityMessageObj);
    }
    if (priority < 1) {
      return res.status(400).send({
        'message': 'Invalid priority provided.',
        'long_message': 'Priority can only be positive integer.',
      });
    }
  }

  // Same status with no priority change requested -> nothing to do
  if (status === oldStatus && !priorityProvided) {
    return res.status(200).send(clients);
  }

  const updateClient = db.transaction(() => {
    if (status === oldStatus) {
      // Reorder within the same swimlane
      const maxPriority = clients
        .filter(c => c.status === status)
        .reduce((max, c) => Math.max(max, c.priority), 0);
      let newPriority = Math.min(priority, maxPriority);

      if (newPriority === oldPriority) {
        return;
      }

      if (newPriority < oldPriority) {
        // Moving up: shift clients in [newPriority, oldPriority) down (+1)
        db.prepare(`
          UPDATE clients
          SET priority = priority + 1
          WHERE status = ? AND priority >= ? AND priority < ? AND id != ?
        `).run(status, newPriority, oldPriority, id);
      } else {
        // Moving down: shift clients in (oldPriority, newPriority] up (-1)
        db.prepare(`
          UPDATE clients
          SET priority = priority - 1
          WHERE status = ? AND priority <= ? AND priority > ? AND id != ?
        `).run(status, newPriority, oldPriority, id);
      }

      db.prepare('UPDATE clients SET priority = ? WHERE id = ?').run(newPriority, id);
      return;
    }

    // Moving to a different swimlane: close the gap in the old swimlane
    db.prepare(`
      UPDATE clients
      SET priority = priority - 1
      WHERE status = ? AND priority > ?
    `).run(oldStatus, oldPriority);

    const destinationClients = db.prepare(
      'SELECT * FROM clients WHERE status = ? ORDER BY priority ASC'
    ).all(status);
    const maxPriority = destinationClients.reduce((max, c) => Math.max(max, c.priority), 0);

    let newPriority;
    if (!priorityProvided) {
      // No priority given: place at the end (lowest priority / biggest number)
      newPriority = maxPriority + 1;
    } else {
      newPriority = Math.min(priority, maxPriority + 1);
      db.prepare(`
        UPDATE clients
        SET priority = priority + 1
        WHERE status = ? AND priority >= ?
      `).run(status, newPriority);
    }

    db.prepare('UPDATE clients SET status = ?, priority = ? WHERE id = ?')
      .run(status, newPriority, id);
  });

  updateClient();
  clients = db.prepare('select * from clients').all();

  return res.status(200).send(clients);
});

app.listen(3001);
console.log('app running on port ', 3001);
