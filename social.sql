DROP TABLE IF EXISTS social;

CREATE TABLE social(
    id SERIAL PRIMARY KEY,
    first VARCHAR(500) NOT NULL,
    last VARCHAR(500) NOT NULL,
    email VARCHAR(500) UNIQUE NOT NULL,
    password VARCHAR(500) NOT NULL,
    imageurl VARCHAR(500),
    usersbio TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);



DROP TABLE IF EXISTS friendships;

CREATE TABLE friendships (
    id SERIAL PRIMARY KEY,
    sender_id INT NOT NULL REFERENCES  social(id),
    receiver_id INT NOT NULL REFERENCES social(id),
    accepted BOOLEAN DEFAULT false
);


-- SELECT * FROM friendships
-- WHERE (receiver_id = $1 AND sender_id = $2)
-- OR (receiver_id = $2 AND sender_id = $1)


DROP TABLE IF EXISTS chat;

CREATE TABLE chat (
    id SERIAL PRIMARY KEY,
    sender_id INT NOT NULL REFERENCES social(id),
    chat_message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


DROP TABLE IF EXISTS feed;

CREATE TABLE feed (
    id SERIAL PRIMARY KEY,
    sender_id INT NOT NULL REFERENCES social(id),
    receiver_id INT NOT NULL REFERENCES social(id),
    feed_text TEXT,
    feed_imageurl VARCHAR(500),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);
