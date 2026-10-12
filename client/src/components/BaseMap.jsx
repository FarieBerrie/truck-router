import { useEffect } from 'react';
import { LayerGroup, LayersControl, MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Satellite tiles exist to about zoom 19 almost everywhere; Leaflet upscales beyond that.
const tile = { maxNativeZoom: 19, maxZoom: 21 };

/** Fits the map to `bounds` whenever `fitKey` changes (not on every render). */
function FitBounds({ bounds, fitKey }) {
  const map = useMap();
  useEffect(() => {
    if (bounds?.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map]);
  return null;
}

function ClickHandler({ onClick }) {
  useMapEvents({ click: (e) => onClick?.(e.latlng) });
  return null;
}

/** Satellite basemap with road and place labels, plus plain imagery and street-map options. */
export default function BaseMap({ children, bounds, fitKey, onMapClick, className = 'map', ...props }) {
  return (
    // No tile fade-in: imagery appears immediately, which is also lighter on in-cab phones.
    <MapContainer className={className} center={[39.5, -98.35]} zoom={4} maxZoom={21} preferCanvas fadeAnimation={false} {...props}>
      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="Satellite + roads">
          <LayerGroup>
            <TileLayer url={`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`} attribution={ESRI_ATTRIBUTION} {...tile} />
            <TileLayer url={`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`} {...tile} />
            <TileLayer url={`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`} {...tile} />
          </LayerGroup>
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Satellite">
          <TileLayer url={`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`} attribution={ESRI_ATTRIBUTION} {...tile} />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Streets">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution={OSM_ATTRIBUTION} maxNativeZoom={19} maxZoom={21} />
        </LayersControl.BaseLayer>
      </LayersControl>
      <FitBounds bounds={bounds} fitKey={fitKey} />
      {onMapClick && <ClickHandler onClick={onMapClick} />}
      {children}
    </MapContainer>
  );
}
