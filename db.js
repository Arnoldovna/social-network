const spicedPg = require("spiced-pg");
// const { dbUser, dbPassword } = require("./secrets.json");
const bcrypt = require("bcryptjs");

let secrets;
if (process.env.NODE_ENV === "production") {
  secrets = process.env;
} else {
  secrets = require("./secrets.json");
}

const dbUrl =
  process.env.DATABASE_URL ||
  `postgres:${secrets.dbUser}:${secrets.dbPassword}@localhost:5432/social`;

const db = spicedPg(dbUrl);

exports.dbPassword = function(email) {
  return db
    .query(`SELECT password FROM social WHERE email = $1`, [email])
    .then(result => {
      return result.rows[0].password;
    });
};

exports.hashPassword = function(plainTextPassword) {
  return new Promise(function(resolve, reject) {
    bcrypt.genSalt(function(err, salt) {
      if (err) {
        return reject(err);
      }
      bcrypt.hash(plainTextPassword, salt, function(err, hash) {
        if (err) {
          return reject(err);
        }
        resolve(hash);
      });
    });
  });
};

exports.checkPassword = function(
  textEnteredInLoginForm,
  hashedPasswordFromDatabase
) {
  return new Promise(function(resolve, reject) {
    bcrypt.compare(textEnteredInLoginForm, hashedPasswordFromDatabase, function(
      err,
      doesMatch
    ) {
      if (err) {
        reject(err);
      } else {
        resolve(doesMatch);
      }
    });
  });
};

exports.insertNewUser = function(first, last, email, hashedPw) {
  const q = `
        INSERT INTO social
        (first, last, email, password)
        VALUES
        ($1, $2, $3, $4)
        RETURNING id
    `;
  const params = [first || null, last || null, email || null, hashedPw || null];

  return db.query(q, params);
};

exports.getUserId = function(email) {
  return db
    .query(`SELECT id FROM social WHERE email = $1`, [email])
    .then(result => {
      return result.rows[0].id;
    });
};

exports.getDataById = function(id) {
  return db.query(`SELECT * FROM social WHERE id=$1`, [id]).then(result => {
    return result.rows[0];
  });
};

exports.uploadImage = function(url, id) {
  return db
    .query(`UPDATE social SET imageurl=$1 WHERE id=$2 returning *`, [url, id])
    .then(result => {
      // console.log("RESULTTTT.rows DB:", result.rows[0]);
      // console.log("RESULTTTT.rows.imageurl DB:", result.rows[0].imageurl);

      return result.rows[0].imageurl;
    });
};

exports.uploadBio = function(usersbio, id) {
  return db
    .query(`UPDATE social SET usersbio=$1 WHERE id=$2 returning *`, [
      usersbio,
      id
    ])
    .then(result => {
      console.log("RESULTTTT.rows.usersbio DB:", result.rows[0].usersbio);

      return result.rows[0].usersbio;
    });
};

exports.getStatus = function(id, otherProfileId) {
  return db
    .query(
      `SELECT * FROM friendships
WHERE (receiver_id = $1 AND sender_id = $2)
OR (receiver_id = $2 AND sender_id = $1)`,
      [id || null, otherProfileId || null]
    )
    .then(result => {
      console.log("RESULTgetStatus DB:", result.rows[0]);

      return result.rows[0];
    });
};

exports.makeRequest = function(id, otherProfileId) {
  return db
    .query(
      `INSERT INTO friendships (sender_id, receiver_id) VALUES ($1, $2) returning *`,
      [id || null, otherProfileId || null]
    )
    .then(result => {
      console.log("RESULT makeRequest DB:", result.rows[0]);
      return result.rows[0].sender_id;
    });
};

exports.cancelRequest = function(id, otherProfileId) {
  return db
    .query(
      `DELETE FROM friendships WHERE sender_id = $1 AND receiver_id = $2 returning *`,
      [id || null, otherProfileId || null]
    )
    .then(result => {
      // console.log("RESULT makeRequest DB:", result.rows[0]);
      return result.rows[0];
    });
};

exports.acceptFriendship = function(id, otherProfileId) {
  return db
    .query(
      `UPDATE friendships SET accepted=true WHERE (sender_id = $2 AND receiver_id = $1) returning *`,
      [id || null, otherProfileId || null]
    )
    .then(result => {
      // console.log("RESULT makeRequest DB:", result.rows[0]);
      return result.rows[0];
    });
};

exports.endFriendship = function(id, otherProfileId) {
  return db
    .query(
      `DELETE FROM friendships WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)returning *`,
      [id || null, otherProfileId || null]
    )
    .then(result => {
      // console.log("RESULT makeRequest DB:", result.rows[0]);
      return result.rows[0];
    });
};

exports.getFriendsOrWanabees = function(id) {
  return db
    .query(
      `SELECT social.id, first, last, imageurl, accepted
    FROM friendships
    JOIN social
    ON (accepted = false AND receiver_id = $1 AND sender_id = social.id)
    OR (accepted = true AND receiver_id= $1 AND sender_id = social.id)
    OR (accepted = true AND sender_id = $1 AND receiver_id = social.id)
`,
      [id || null]
    )
    .then(data => {
      // console.log("RESULT IN GET FRIEND OR WANABEES DB:", data.rows);
      return data.rows;
    });
};

exports.getUsersByIDs = function(arrayOfIDs) {
  const query = `SELECT id, first, last, imageurl FROM social WHERE id = ANY($1)`;
  return db.query(query, [arrayOfIDs]);
};

exports.saveChatMessage = function(sender_id, chat_message) {
  const q = `
        INSERT INTO chat
        (sender_id, chat_message)
        VALUES
        ($1, $2)
        RETURNING *
    `;
  const params = [sender_id || null, chat_message || null];

  return db.query(q, params);
};

exports.showLastTenMessages = function() {
  return db
    .query(
      `SELECT social.first, social.last, social.imageurl, chat.chat_message, chat.created_at, chat.id, chat.sender_id
                FROM social
                JOIN chat
                ON social.id = chat.sender_id
                ORDER BY chat.id DESC LIMIT 10`
    )
    .then(result => {
      // console.log("showLast10Messages DB:", result.rows);
      return result.rows;
    });
};

exports.showWallPosts = function(receiver_id) {
  return db
    .query(
      `SELECT social.first, social.last, social.imageurl, feed_text, feed.created_at, feed_imageurl, feed.id
                FROM social
                JOIN feed
                ON (feed.receiver_id = $1 AND feed.sender_id = social.id)
                ORDER BY feed.id ASC
                `,
      [receiver_id || null]
    )
    .then(result => {
      // console.log("showWallPosts DB:", result.rows);
      return result.rows;
    });
};

exports.uploadPost = function(receiver_id, sender_id, feed_text) {
  const q = `
        INSERT INTO feed
        (receiver_id, sender_id, feed_text)
        VALUES
        ($1, $2, $3)
        RETURNING *
    `;
  const params = [receiver_id || null, sender_id || null, feed_text || null];

  return db.query(q, params);
};

exports.deletePost = function(postId) {
  return db
    .query(`DELETE FROM feed WHERE id = $1 RETURNING *`, [postId])
    .then(result => {
      return result.rows[0].id;
    });
};

exports.searchUser = function(input) {
  console.log("dfdfdfdf", input);
  return db
    .query(
      `SELECT first, last, imageurl, id
    FROM social
    WHERE first ILIKE $1 OR last ILIKE $1
    `,
      [input + "%" || null]
    )
    .then(result => {
      console.log("RESULT SEARCH USER DB:", result.rows[0]);
      return result.rows[0];
    });
};
