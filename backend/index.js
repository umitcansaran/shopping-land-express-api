const express = require("express");
const app = express();
const cors = require("cors");
const pool = require("./db");
const path = require("path");
require("dotenv").config();
const bcrypt = require("bcryptjs");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const loggedInUser = require("./middleware/loggedInUser");
const { getStoresByOwnerId } = require("./queries/storeQueries");
const { getUserDetailsById, getAllUsers } = require("./queries/userQueries");
const {
  getAllStocks,
  getAllStocksByStore,
  getAllStocksByProduct,
} = require("./queries/stockQueries");
const { getReviewsByProductId } = require("./queries/reviewQueries");

const s3 = require("./s3-config");

app.use(bodyParser.urlencoded({ extended: true }));

app.use(bodyParser.json());

// Middleware
app.use(cors());
app.use(express.json()); //req.body

// JWT secret key (store securely in env variables)
const JWT_SECRET = process.env.JWT_SECRET_KEY;

// Start the server and listen on port
const PORT = process.env.PORT || 80;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Check db connection
pool.connect((err, client, release) => {
  if (err) {
    return console.error("Error acquiring client", err.stack);
  }
  console.log("Connected to the database");
  release(); // release the client back to the pool
});

// Serve static files from the React frontend app
app.use(express.static(path.join(__dirname, "../frontend/build"))); 

// Append the S3 bucket url to the image value (relative path)
function addToImagePath(arr, stringToAdd) {
  return arr.map((obj) => {
    if (obj.hasOwnProperty("image")) {
      obj.image = stringToAdd + obj.image;
    }
    if (obj.hasOwnProperty("profile_image")) {
      obj.profile_image = stringToAdd + obj.profile_image;
    }
    if (obj.product && obj.product.hasOwnProperty("image")) {
      obj.product.image = stringToAdd + obj.product.image;
    }
    return obj;
  });
}

// Products route
const productsRoutes = require("./routes/products");
app.use("/api/products", productsRoutes);

// Profiles route
const profilesRoutes = require("./routes/profiles");
app.use("/api/profiles", profilesRoutes);

app.get("/api/profiles/:id(\\d+)", async (req, res) => {
  const profileId = req.params.id;
  try {
    const allProfiles = await pool.query(
      `
      SELECT base_profile.*,
       auth_user.username AS name
      FROM base_profile
      JOIN auth_user ON base_profile.user_id = auth_user.id
      WHERE base_profile.id = $1
      `,
      [profileId]
    );

    const response = addToImagePath(
      allProfiles.rows,
      process.env.AWS_S3_BUCKET_URL
    );

    res.json(response[0]);
  } catch (err) {
    console.error(err.message);
  }
});

// GET last 5 sellers profiles registered
app.get("/api/profiles/latest-sellers", async (req, res) => {
  try {
    const latestSellers = await pool.query(
      "SELECT * FROM base_profile WHERE status = 'STORE_OWNER' ORDER BY id DESC LIMIT 5"
    );
    let response = latestSellers.rows;

    addToImagePath(response, process.env.AWS_S3_BUCKET_URL);
    res.json(response);
  } catch (err) {
    console.error(err.message);
  }
});

// GET seller profiles only
app.get("/api/profiles/sellers", async (req, res) => {
  try {
    const profiles = await pool.query(
      "SELECT * FROM base_profile WHERE status = 'STORE_OWNER'"
    );
    let response = profiles.rows;

    addToImagePath(response, process.env.AWS_S3_BUCKET_URL);

    res.json(response);
  } catch (err) {
    console.error(err.message);
  }
});

// GET search all products
app.get("/api/search", async (req, res) => {
  const searchQuery = req.query.search_string
    ? `%${req.query.search_string}%`
    : "%%";

  if (req.query.type === "all") {
    try {
      const allProducts = await pool.query(
        "SELECT * FROM base_product LEFT JOIN auth_user ON base_product.seller_id = auth_user.id WHERE LOWER(base_product.brand) LIKE LOWER($1) OR LOWER(base_product.name) LIKE LOWER($1) OR LOWER(auth_user.username) LIKE LOWER($1)",
        [searchQuery]
      );

      const response = addToImagePath(
        allProducts.rows,
        process.env.AWS_S3_BUCKET_URL
      );

      res.json(response);
    } catch (err) {
      console.error(err.message);
    }
  }

  if (req.query.type === "products_by_seller") {
    try {
      const allProducts = await pool.query(
        `
        SELECT *
        FROM base_product
        LEFT JOIN auth_user ON base_product.seller_id = auth_user.id
        WHERE (LOWER(base_product.brand) LIKE LOWER($2)
              OR LOWER(base_product.name) LIKE LOWER($2))
          AND auth_user.id = $1;
        `,
        [req.query.seller_id, searchQuery]
      );

      const response = addToImagePath(
        allProducts.rows,
        process.env.AWS_S3_BUCKET_URL
      );

      res.json(response);
    } catch (err) {
      console.error(err.message);
    }
  }

  if (req.query.type === "products") {
    try {
      const allProducts = await pool.query(
        `
        SELECT *
        FROM base_product
        LEFT JOIN base_productcategory ON base_productcategory.id = base_product.category_id
        LEFT JOIN base_productsubcategory ON base_productsubcategory.id = base_product.subcategory_id
        WHERE base_productcategory.name ILIKE $1
          OR base_productsubcategory.name ILIKE $1;
            `,
        [searchQuery]
      );

      const response = addToImagePath(
        allProducts.rows,
        process.env.AWS_S3_BUCKET_URL
      );

      res.json(response);
    } catch (err) {
      console.error(err.message);
    }
  }

  if (req.query.type === "products_in_my_store") {
    try {
      const allProducts = await pool.query(
        `
        SELECT base_stock.id,
              jsonb_build_object('id', base_product.id, 'name', base_product.name, 'price', base_product.price, 'brand', base_product.brand) AS product,
              base_store.name AS storeName,
              base_stock.number,
              base_store.id AS store
        FROM base_stock
        JOIN base_store ON base_stock.store_id = base_store.id
        JOIN base_product ON base_stock.product_id = base_product.id
        WHERE base_store.id = $1
          AND (CAST(base_product.id AS TEXT) ILIKE '%' || $2 || '%'
              OR base_product.brand ILIKE '%' || $2 || '%'
              OR base_product.name ILIKE '%' || $2 || '%')
        GROUP BY base_stock.id,
                base_product.id,
                base_store.id;
                `,
        [req.query.store_id, searchQuery]
      );

      const response = addToImagePath(
        allProducts.rows,
        process.env.AWS_S3_BUCKET_URL
      );

      res.json(response);
    } catch (err) {
      console.error(err.message);
    }
  }

  if (req.query.type === "stores" || req.query.type === "map") {
    try {
      const allStores = await pool.query(
        `
      SELECT base_store.*,
            base_profile.image AS profile_image,
            auth_user.username AS owner_name,
            base_profile_category.id,
            base_productcategory.name AS category
      FROM base_store
      LEFT JOIN auth_user ON base_store.owner_id = auth_user.id
      LEFT JOIN base_profile ON auth_user.id = base_profile.user_id
      LEFT JOIN base_profile_category ON base_profile.id = base_profile_category.profile_id
      LEFT JOIN base_productcategory ON base_profile_category.productcategory_id = base_productcategory.id
      WHERE ($1 = '%%'
            OR auth_user.username ILIKE $1
            OR base_productcategory.name ILIKE $1)
      `,
        [searchQuery]
      );

      const response = addToImagePath(
        allStores.rows,
        process.env.AWS_S3_BUCKET_URL
      );

      res.json(response);
    } catch (err) {
      console.error(err.message);
    }
  }

  if (req.query.type === "products_in_store") {
    try {
      const allProducts = await pool.query(
        `
        SELECT base_stock.id,
          jsonb_build_object('id', base_product.id, 'name', base_product.name, 'price', base_product.price, 'brand', base_product.brand, 'image', base_product.image) AS product,
          base_store.name AS storeName,
          base_stock.number,
          base_store.id AS store 
        FROM base_stock
        JOIN base_store ON base_stock.store_id = base_store.id
        JOIN base_product ON base_stock.product_id = base_product.id
        WHERE base_store.id = $1
        AND (CAST(base_product.id AS TEXT) ILIKE '%' || $2 || '%'
                    OR base_product.brand ILIKE '%' || $2 || '%'
                    OR base_product.name ILIKE '%' || $2 || '%')
        GROUP BY base_stock.id,
                base_product.id,
                base_store.id;`,
        [req.query.store_id, searchQuery]
      );

      const response = addToImagePath(
        allProducts.rows,
        process.env.AWS_S3_BUCKET_URL
      );

      res.json(response);
    } catch (err) {
      console.error(err.message);
    }
  }
});

// POST user registration
app.post("/api/users/registration", async (req, res) => {
  const { username, email, password } = req.body;

  try {
    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({ detail: "All fields are required." });
    }

    // Check if the email or username already exists
    const userCheckQuery =
      "SELECT * FROM auth_user WHERE email = $1 OR username = $2";
    const userCheckResult = await pool.query(userCheckQuery, [email, username]);
    if (userCheckResult.rows.length > 0) {
      return res
        .status(400)
        .json({ detail: "Username or email already exists." });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 8);

    // Insert user into the database
    const date = new Date();

    // Format date components
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");
    const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");
    const microseconds = "000"; // Simulated as JavaScript doesn't provide microseconds natively

    // Combine into the required format
    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}${microseconds}+00`;

    const insertUserQuery = `
            INSERT INTO auth_user (username, email, password, is_superuser, first_name, last_name, is_staff, is_active, date_joined) 
            VALUES ($1, $2, $3, false, $1, $1, false, true, '${timestamp}') 
            RETURNING id, username, email
        `;
    const insertUserResult = await pool.query(insertUserQuery, [
      username,
      email,
      hashedPassword,
    ]);

    // Return the new user (excluding the password)
    const newUser = insertUserResult.rows[0];
    res
      .status(201)
      .json({ detail: "User registered successfully!", id: newUser.id });
  } catch (err) {
    console.error("Error registering user:", err.message);
    res.status(500).json({ detail: "Server error." });
  }
});

// POST create a profile
app.post("/api/profiles/new", async (req, res) => {
  const { user, status } = req.body;
  try {
    const insertProfileuery = `
          INSERT INTO base_profile (user_id, status) 
          VALUES ($1, $2) 
          RETURNING id, status
      `;
    const insertProfileResult = await pool.query(insertProfileuery, [
      user,
      status,
    ]);
    // Return the new user (excluding the password)
    const newProfile = insertProfileResult.rows[0];
    res
      .status(201)
      .json({ detail: "Profile created successfully!", profile: newProfile });
  } catch (err) {
    console.error("Error registering user:", err.message);
    res.status(500).json({ detail: "Server error." });
  }
});

// POST login user
app.post("/api/users/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM auth_user WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = result.rows[0];

    // Verify if a password was hashed using PBKDF2 algorithm. Used for authenticating users migrated from a previous Django backend.
    function verifyDjangoPassword(plainPassword, djangoHashedPassword) {
      const [algorithm, iterations, salt, hash] =
        djangoHashedPassword.split("$");

      // if (algorithm !== "pbkdf2_sha256") {
      //   throw new Error("Unsupported hashing algorithm");
      // }

      const derivedKey = crypto
        .pbkdf2Sync(plainPassword, salt, parseInt(iterations), 32, "sha256")
        .toString("base64");

      return derivedKey === hash;
    }

    const plainPassword = password;
    const djangoHashedPassword = user.password;

    const isValid = verifyDjangoPassword(plainPassword, djangoHashedPassword);

    // Verify bcrypt-hashed passwords for authenticity.
    if (!isValid) {
      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
    }

    // Generate tokens
    const access = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "1d",
    });
    const refresh = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ access, refresh });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// GET Logged in user's details
app.get("/api/users/me", loggedInUser, async (req, res) => {
  try {
    const response = await getUserDetailsById(req.user.userId);
    response.profile.image =
      process.env.AWS_S3_BUCKET_URL + response.profile.image;
    res.json(response);
  } catch (err) {
    console.error(err.message);
  }
});

// GET All user profiles
app.get("/api/users", async (req, res) => {
  try {
    const response = await getAllUsers();
    res.json(response);
  } catch (err) {
    console.error(err.message);
  }
});

// GET All stores of a logged in user with a "Seller" profile
app.get("/api/stores/mystores", loggedInUser, async (req, res) => {
  try {
    const response = await getStoresByOwnerId(req.user.userId);
    res.json(response);
  } catch (err) {
    console.error(err.message);
  }
});

app.get("/api/stocks/product/:product_id(\\d+)", async (req, res) => {
  try {
    const response = await getAllStocksByProduct(req.params.product_id);
    res.json(response);
  } catch (err) {
    console.error(err.message);
  }
});

// GET - List all the stocks
app.get("/api/stocks", async (req, res) => {
  try {
    const response = await getAllStocks();
    res.json(response);
  } catch (err) {
    console.error(err.message);
  }
});

// GET - List all the stocks of a store
app.get("/api/stocks/store/:storeId", async (req, res) => {
  try {
    const response = await getAllStocksByStore(req.params.storeId);
    res.json(response);
  } catch (err) {
    console.error(err.message);
  }
});

app.get("/api/stores/user/:id", async (req, res) => {
  const userId = req.params.id;
  try {
    const allStores = await pool.query(
      `
      SELECT base_store.*,
       auth_user.username AS owner_name
      FROM base_store
      LEFT JOIN auth_user ON base_store.owner_id = auth_user.id
      WHERE auth_user.id = $1
      `,
      [userId]
    );
    res.json(allStores.rows);
  } catch (err) {
    console.error(err.message);
  }
});

// GET All stores
app.get("/api/stores", async (req, res) => {
  try {
    const allStores = await pool.query(`
      SELECT base_store.*,
       auth_user.username AS owner_name
      FROM base_store
      LEFT JOIN auth_user ON base_store.owner_id = auth_user.id
      `);
    res.json(allStores.rows);
  } catch (err) {
    console.error(err.message);
  }
});
