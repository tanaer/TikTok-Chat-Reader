from peewee import *
from datetime import datetime
import json

db = SqliteDatabase('data.db')

class BaseModel(Model):
    class Meta:
        database = db

class Room(BaseModel):
    room_id = CharField(unique=True)
    name = CharField(null=True)
    address = CharField(null=True)
    updated_at = DateTimeField(default=datetime.now)

class Session(BaseModel):
    session_id = CharField(unique=True) # YYYYMMDDNN
    room_id = CharField()
    snapshot_json = TextField() # JSON string of aggregated stats
    created_at = DateTimeField(default=datetime.now)

class Event(BaseModel):
    room_id = CharField()
    type = CharField() # gift, chat, like, etc.
    timestamp = DateTimeField(default=datetime.now)
    data_json = TextField() # Raw event data

def init_db():
    db.connect()
    db.create_tables([Room, Session, Event])
