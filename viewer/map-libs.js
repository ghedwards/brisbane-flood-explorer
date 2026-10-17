import L from "leaflet";
import * as esri from "esri-leaflet";
import "leaflet/dist/leaflet.css";
import marker from "leaflet/dist/images/marker-icon.png";
import marker2x from "leaflet/dist/images/marker-icon-2x.png";
import shadow from "leaflet/dist/images/marker-shadow.png";
L.Icon.Default.imagePath = "";
L.Icon.Default.mergeOptions({
  iconUrl: marker,
  iconRetinaUrl: marker2x,
  shadowUrl: shadow,
});
L.esri = esri;
window.L = L;
