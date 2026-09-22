import { mount } from 'svelte';
import App from './App.svelte';
import { initLocale } from './i18n';
import './app.css';

initLocale();

const target = document.getElementById('app');
if (target == null) throw new Error('#app missing');
mount(App, { target });
