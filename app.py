
from flask import (
    Flask, render_template, request,
    redirect, url_for, session, flash, jsonify
)
import sqlite3
import json
import os
from datetime import datetime

from werkzeug.security import (
    generate_password_hash,
    check_password_hash
)

app = Flask(__name__)
app.secret_key = "tablet-reminder-local-secret-key"

# DATABASE PATH
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.path.join(BASE_DIR, "users.db")


# --------------------------------
# DATABASE CONNECTION
# --------------------------------

def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn


# --------------------------------
# CREATE DATABASE TABLES
# --------------------------------

def create_table():

    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS tablet_stock (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            medicine_name TEXT COLLATE NOCASE NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 0,
            low_threshold INTEGER NOT NULL DEFAULT 5,
            expiry_date TEXT,
            UNIQUE(user_id, medicine_name),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    """)

    columns = [
        row["name"]
        for row in cursor.execute(
            "PRAGMA table_info(tablet_stock)"
        ).fetchall()
    ]

    if "expiry_date" not in columns:
        cursor.execute("""
            ALTER TABLE tablet_stock
            ADD COLUMN expiry_date TEXT
        """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reminder_key TEXT NOT NULL,
            reminder_data TEXT NOT NULL,
            UNIQUE(user_id, reminder_key),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    """)

    # MEDICINE STOCK HISTORY TABLE
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS stock_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            medicine_name TEXT NOT NULL,
            action TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            activity_date TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    """)

    conn.commit()
    conn.close()


# --------------------------------
# RECORD STOCK HISTORY
# --------------------------------

def record_stock_history(
    cursor, user_id, medicine_name, action, quantity
):

    cursor.execute("""
        INSERT INTO stock_history (
            user_id,
            medicine_name,
            action,
            quantity,
            activity_date
        )
        VALUES (?, ?, ?, ?, ?)
    """, (
        user_id,
        medicine_name,
        action,
        quantity,
        datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ))


# --------------------------------
# GET LOGGED-IN USER
# --------------------------------

def get_user_id():

    username = session.get("username")

    if not username:
        return None

    conn = get_db()

    user = conn.execute(
        "SELECT id FROM users WHERE username = ?",
        (username,)
    ).fetchone()

    conn.close()

    if user:
        return user["id"]

    return None


# --------------------------------
# HOME PAGE
# --------------------------------

@app.route("/")
def index():

    if "username" in session:
        return render_template(
            "index.html",
            username=session["username"]
        )

    return redirect(url_for("login"))


# --------------------------------
# REGISTER
# --------------------------------

@app.route("/register", methods=["GET", "POST"])
def register():

    if request.method == "POST":

        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        if not username or not password:
            flash("Please enter username and password.")
            return redirect(url_for("register"))

        hashed_password = generate_password_hash(password)

        conn = get_db()

        try:
            conn.execute(
                """
                INSERT INTO users (username, password)
                VALUES (?, ?)
                """,
                (username, hashed_password)
            )

            conn.commit()
            flash("Registration successful! Please log in.")

            return redirect(url_for("login"))

        except sqlite3.IntegrityError:
            flash("Username already exists.")

        finally:
            conn.close()

    return render_template("register.html")


# --------------------------------
# LOGIN
# --------------------------------

@app.route("/login", methods=["GET", "POST"])
def login():

    if request.method == "POST":

        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        conn = get_db()

        user = conn.execute(
            "SELECT * FROM users WHERE username = ?",
            (username,)
        ).fetchone()

        conn.close()

        if user and check_password_hash(
            user["password"], password
        ):

            session["username"] = user["username"]

            return redirect(url_for("index"))

        flash("Invalid username or password.")

    return render_template("login.html")


# --------------------------------
# LOGOUT
# --------------------------------

@app.route("/logout")
def logout():

    session.clear()

    return redirect(url_for("login"))


# --------------------------------
# REMINDER API
# --------------------------------

@app.route("/api/reminders", methods=["GET", "POST"])
def reminders_api():

    user_id = get_user_id()

    if not user_id:
        return jsonify({"error": "Please log in."}), 401

    conn = get_db()
    cursor = conn.cursor()

    if request.method == "GET":

        rows = cursor.execute(
            """
            SELECT reminder_data
            FROM reminders
            WHERE user_id = ?
            ORDER BY id
            """,
            (user_id,)
        ).fetchall()

        conn.close()

        result = []

        for row in rows:
            try:
                result.append(json.loads(row["reminder_data"]))
            except json.JSONDecodeError:
                continue

        return jsonify(result)

    data = request.get_json(silent=True) or {}
    reminder_list = data.get("reminders")

    if not isinstance(reminder_list, list):
        conn.close()
        return jsonify({"error": "Invalid reminder data."}), 400

    try:

        cursor.execute("BEGIN")

        cursor.execute(
            "DELETE FROM reminders WHERE user_id = ?",
            (user_id,)
        )

        for item in reminder_list:

            if not isinstance(item, dict) or item.get("id") is None:
                raise ValueError("Every reminder must have an ID.")

            reminder_key = str(item["id"])

            cursor.execute(
                """
                INSERT INTO reminders (
                    user_id,
                    reminder_key,
                    reminder_data
                )
                VALUES (?, ?, ?)
                """,
                (
                    user_id,
                    reminder_key,
                    json.dumps(item)
                )
            )

        conn.commit()
        conn.close()

        return jsonify({
            "success": True,
            "message": "Reminders saved successfully."
        })

    except Exception as error:

        conn.rollback()
        conn.close()

        return jsonify({"error": str(error)}), 400


# --------------------------------
# VALIDATE EXPIRY DATE
# --------------------------------

def validate_expiry_date(expiry_date):

    if not expiry_date:
        return None

    try:
        datetime.strptime(expiry_date, "%Y-%m-%d")
        return expiry_date

    except ValueError:
        return False


# --------------------------------
# GET AND ADD TABLET STOCK
# --------------------------------

@app.route("/api/stock", methods=["GET", "POST"])
def stock_api():

    user_id = get_user_id()

    if not user_id:
        return jsonify({"error": "Please log in."}), 401

    conn = get_db()
    cursor = conn.cursor()

    if request.method == "GET":

        rows = cursor.execute(
            """
            SELECT *
            FROM tablet_stock
            WHERE user_id = ?
            ORDER BY medicine_name
            """,
            (user_id,)
        ).fetchall()

        conn.close()

        return jsonify([dict(row) for row in rows])

    data = request.get_json(silent=True) or {}

    medicine_name = data.get("medicine_name", "").strip()

    try:
        quantity = int(data.get("quantity", 0))
    except (TypeError, ValueError):
        conn.close()
        return jsonify({"error": "Invalid quantity."}), 400

    expiry_date = data.get("expiry_date")

    if expiry_date is not None:
        expiry_date = str(expiry_date).strip()

    expiry_date = validate_expiry_date(expiry_date)

    if expiry_date is False:
        conn.close()
        return jsonify({"error": "Invalid expiry date."}), 400

    if not medicine_name or quantity <= 0:
        conn.close()
        return jsonify({
            "error": "Enter valid medicine and quantity."
        }), 400

    try:

        cursor.execute(
            """
            INSERT INTO tablet_stock (
                user_id,
                medicine_name,
                quantity,
                expiry_date
            )
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, medicine_name)
            DO UPDATE SET
                quantity = quantity + excluded.quantity,
                expiry_date = COALESCE(
                    excluded.expiry_date,
                    tablet_stock.expiry_date
                )
            """,
            (user_id, medicine_name, quantity, expiry_date)
        )

        record_stock_history(
            cursor,
            user_id,
            medicine_name,
            "Added",
            quantity
        )

        conn.commit()
        conn.close()

        return jsonify({
            "success": True,
            "message": "Stock added successfully."
        })

    except Exception as error:

        conn.rollback()
        conn.close()
        return jsonify({"error": str(error)}), 400


# --------------------------------
# UPDATE OR DELETE STOCK ITEM
# --------------------------------

@app.route("/api/stock/<int:stock_id>", methods=["PUT", "DELETE"])
def stock_item(stock_id):

    user_id = get_user_id()

    if not user_id:
        return jsonify({"error": "Please log in."}), 401

    conn = get_db()
    cursor = conn.cursor()

    item = cursor.execute(
        """
        SELECT medicine_name, quantity
        FROM tablet_stock
        WHERE id = ? AND user_id = ?
        """,
        (stock_id, user_id)
    ).fetchone()

    if not item:
        conn.close()
        return jsonify({"error": "Stock item not found."}), 404

    if request.method == "DELETE":

        record_stock_history(
            cursor,
            user_id,
            item["medicine_name"],
            "Deleted",
            item["quantity"]
        )

        cursor.execute(
            """
            DELETE FROM tablet_stock
            WHERE id = ? AND user_id = ?
            """,
            (stock_id, user_id)
        )

        conn.commit()
        conn.close()

        return jsonify({"success": True})

    data = request.get_json(silent=True) or {}

    try:
        quantity = int(data.get("quantity", -1))
    except (TypeError, ValueError):
        conn.close()
        return jsonify({"error": "Invalid quantity."}), 400

    if quantity < 0:
        conn.close()
        return jsonify({"error": "Quantity cannot be negative."}), 400

    cursor.execute(
        """
        UPDATE tablet_stock
        SET quantity = ?
        WHERE id = ? AND user_id = ?
        """,
        (quantity, stock_id, user_id)
    )

    conn.commit()
    conn.close()

    return jsonify({"success": True})


# --------------------------------
# RESTOCK TABLETS
# --------------------------------

@app.route("/api/stock/<int:stock_id>/restock", methods=["POST"])
def restock_stock(stock_id):

    user_id = get_user_id()

    if not user_id:
        return jsonify({"error": "Please log in."}), 401

    data = request.get_json(silent=True) or {}

    try:
        quantity = int(data.get("quantity", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid quantity."}), 400

    if quantity <= 0:
        return jsonify({"error": "Enter a positive quantity."}), 400

    conn = get_db()
    cursor = conn.cursor()

    item = cursor.execute(
        """
        SELECT medicine_name
        FROM tablet_stock
        WHERE id = ? AND user_id = ?
        """,
        (stock_id, user_id)
    ).fetchone()

    if not item:
        conn.close()
        return jsonify({"error": "Stock item not found."}), 404

    cursor.execute(
        """
        UPDATE tablet_stock
        SET quantity = quantity + ?
        WHERE id = ? AND user_id = ?
        """,
        (quantity, stock_id, user_id)
    )

    record_stock_history(
        cursor,
        user_id,
        item["medicine_name"],
        "Restocked",
        quantity
    )

    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "message": "Stock updated successfully."
    })


# --------------------------------
# DEDUCT ONE TABLET
# --------------------------------

@app.route("/api/stock/<int:stock_id>/use", methods=["POST"])
def use_stock(stock_id):

    user_id = get_user_id()

    if not user_id:
        return jsonify({"error": "Please log in."}), 401

    conn = get_db()
    cursor = conn.cursor()

    item = cursor.execute(
        """
        SELECT medicine_name
        FROM tablet_stock
        WHERE id = ? AND user_id = ?
        """,
        (stock_id, user_id)
    ).fetchone()

    if not item:
        conn.close()
        return jsonify({
            "error": "Stock item not found."
        }), 400

    cursor.execute(
        """
        UPDATE tablet_stock
        SET quantity = quantity - 1
        WHERE id = ?
        AND user_id = ?
        AND quantity > 0
        """,
        (stock_id, user_id)
    )

    if cursor.rowcount == 0:
        conn.close()
        return jsonify({
            "error": "Stock quantity is zero."
        }), 400

    record_stock_history(
        cursor,
        user_id,
        item["medicine_name"],
        "Used",
        1
    )

    conn.commit()
    conn.close()

    return jsonify({
        "success": True,
        "message": "One tablet deducted from stock."
    })


# --------------------------------
# MEDICINE REFILL HISTORY API
# --------------------------------

@app.route("/api/stock-history", methods=["GET"])
def stock_history_api():

    user_id = get_user_id()

    if not user_id:
        return jsonify({"error": "Please log in."}), 401

    conn = get_db()

    rows = conn.execute(
        """
        SELECT
            id,
            medicine_name,
            action,
            quantity,
            activity_date
        FROM stock_history
        WHERE user_id = ?
        ORDER BY id DESC
        """,
        (user_id,)
    ).fetchall()

    conn.close()

    return jsonify([dict(row) for row in rows])


# --------------------------------
# RUN APPLICATION
# --------------------------------

if __name__ == "__main__":

    create_table()

    print("Database location:", DATABASE)
    print("Database connected successfully!")

    app.run(debug=True)
