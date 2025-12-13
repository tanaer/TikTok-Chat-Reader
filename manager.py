import json
import os
from datetime import datetime, timedelta
from database import Room, Session, Event, db
from peewee import fn

PRICE_FILE = 'prices.json'

class Manager:
    def __init__(self):
        self.prices = self.load_prices()

    def load_prices(self):
        if os.path.exists(PRICE_FILE):
            try:
                with open(PRICE_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                return {}
        return {}

    def save_price(self, gift_id, price):
        self.prices[str(gift_id)] = price
        with open(PRICE_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.prices, f, ensure_ascii=False, indent=2)

    def get_price(self, gift_id):
        return float(self.prices.get(str(gift_id), 0))

    def update_room(self, room_id, name, address):
        with db.atomic():
            room, created = Room.get_or_create(room_id=room_id)
            room.name = name
            room.address = address
            room.updated_at = datetime.now()
            room.save()
            return room

    def get_rooms(self):
        return list(Room.select().dicts())

    def create_session(self, room_id, snapshot_data):
        now = datetime.now()
        date_str = now.strftime('%Y%m%d')
        
        # Find next session number for today
        count = Session.select().where(Session.session_id.startswith(date_str)).count()
        session_id = f"{date_str}{count + 1:02d}"
        
        Session.create(
            session_id=session_id,
            room_id=room_id,
            snapshot_json=json.dumps(snapshot_data),
            created_at=now
        )
        return session_id

    def get_sessions(self, room_id=None):
        query = Session.select().order_by(Session.created_at.desc())
        if room_id:
            query = query.where(Session.room_id == room_id)
        return list(query.dicts())
    
    def get_session(self, session_id):
        try:
            s = Session.get(Session.session_id == session_id)
            return json.loads(s.snapshot_json)
        except Session.DoesNotExist:
            return None

    def log_event(self, room_id, event_type, data):
        Event.create(
            room_id=room_id,
            type=event_type,
            data_json=json.dumps(data)
        )

    def get_time_stats(self, room_id, start_time=None):
        # Determine time range (e.g. today). For now, listing all for the room.
        # Group by 30 min intervals. doing this in python for simplicity if volume is low, 
        # or SQL if high. Let's do a simple python aggregation for now as peewee SQL grouping 
        # on timestamps can be tricky across DB engines.
        
        events = Event.select().where(
            (Event.room_id == room_id) & 
            (Event.type.in_(['gift', 'chat']))
        ).order_by(Event.timestamp.asc())

        stats = {} 
        # Key: "HH:00-HH:30"
        
        for e in events:
            # Round to nearest 30 mins
            dt = e.timestamp
            minute = dt.minute
            if minute < 30:
                start_str = f"{dt.hour:02d}:00"
                end_str = f"{dt.hour:02d}:30"
            else:
                start_str = f"{dt.hour:02d}:30"
                end_str = f"{dt.hour + 1:02d}:00" # Simple logic, handle 24h wrap if needed (not for single day usually)
            
            # Handle hour wrap for display (23:30-24:00 -> 23:30-00:00)
            if end_str == "24:00": end_str = "00:00"

            key = f"{start_str}-{end_str}"
            if key not in stats:
                stats[key] = {'income': 0, 'comments': 0}
            
            if e.type == 'chat':
                stats[key]['comments'] += 1
            elif e.type == 'gift':
                data = json.loads(e.data_json)
                # Calculate value using current prices (or price at time? stored in data usually, but let's use manager)
                # Actually, gift events from tiktok-live-connector usually have numeric diamond cost.
                # If we rely on custom price, we use self.get_price
                gift_id = data.get('giftId')
                # Try to get cost from data first (diamond count), if not, fallback or custom
                # User asked for '单价' persistence, implies custom price overriding or defining.
                # We multiply count * price.
                count = data.get('repeatCount', 1) # Sometimes repeatCount, sometimes just 1 event per send
                # Note: TikTokLive usually sends 'streak' or individual. 
                # Let's assume standard event handling.
                price = self.get_price(gift_id)
                # If price is 0, maybe try 'diamondCount' from payload if available? 
                # User requirements say "Unit Price Edit", so we rely on that.
                stats[key]['income'] += count * price
        
        # Convert to list
        result = []
        for time_range, val in stats.items():
            result.append({
                'time_range': time_range,
                'income': val['income'],
                'comments': val['comments']
            })
        return result

manager = Manager()
