**bikedata.geojson** are the CDPHP bike rack locations. These are free for students since 2018

CDTA bus routes and schedules are located in the **gtfs/** folder; access to live bus locations is limited.
	- Routes are filtered by region in cdta-by-region.json for use in the interface
		- Only includes route numbers, not their short descriptions, and some routes overlap: they can be displayed twice if their checkboxes update together

Shuttle routes and locations are included here, but for the live locations, 
  use **https://shuttles.rpi.edu/api/locations** and **https://shuttles.rpi.edu/api/velocities** - public JSON with no API key
