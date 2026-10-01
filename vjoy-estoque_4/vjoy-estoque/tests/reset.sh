#!/bin/sh
# recria o banco de teste local
su postgres -c "dropdb --if-exists vjoyestoque_test" && su postgres -c "createdb -O app vjoyestoque_test"
