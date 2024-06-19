#/bin/bash
export USER="lotusbot"
export INSTALLDIR="/opt"
export HOMEDIR="$INSTALLDIR/lotusbot"

# PostgreSQL details
DB_HOST='127.0.0.1'
DB_PORT='5432'
DB_NAME='lotusbot'
DB_SCHEMA='lotusbot'
DB_USER='lotusbot'
DB_PASS='lotusbot'
DB_STRING="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=${DB_SCHEMA}"

# Fail if not root
if [ $(whoami) != "root" ];
then
  echo "You must run this script with sudo or as root"
  exit 1
fi

# Create the database
sudo -u postgres -i <<EOF
psql
CREATE USER '${DB_USER}' ENCRYPTED PASSWORD '${DB_PASS}';
CREATE SCHEMA '${DB_SCHEMA}' AUTHORIZATION '${DB_USER}';
CREATE DATABASE '${DB_NAME}' OWNER '${DB_USER}';
\q
EOF

# Set up and clone the repo
mkdir -p $HOMEDIR
git clone https://github.com/LotusiaStewardship/lotus-bot.git $HOMEDIR

# Create bot user
useradd \
  --home-dir $HOMEDIR \
  --no-create-home \
  --system \
  $USER

# Create bot home folder and set ownership
GROUP=$(cat /etc/passwd | grep $USER | cut -d ':' -f 4)
chown -R $USER:$GROUP $HOMEDIR

# Run as bot user to configure app and push database schema
sudo -u $USER -i /bin/bash <<EOF
cp .env.example .env
sed -i 's/^DATABASE_URL/\#DATABASE_URL/' ".env"
echo DATABASE_URL=\"${DB_STRING}\" >> .env
npm install
npx prisma generate
npx prisma db push
EOF

# Install service files
cp ./install/lotus-bot.service /etc/systemd/system
systemctl daemon-reload
