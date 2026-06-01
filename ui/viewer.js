import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Design Viewer', version: '1.0.0' });
app.ontoolresult = ({ structuredContent: { urn, config } = {} }) => {
    if (urn && config) loadModel(urn, config);
};
app.connect();
app.requestDisplayMode({ mode: 'pip' });

let viewerInitializedPromise = null;

function loadModel(urn, config) {
    if (!viewerInitializedPromise) {
        viewerInitializedPromise = new Promise((resolve) => {
            Autodesk.Viewing.Initializer(config, () => {
                const viewer = new Autodesk.Viewing.GuiViewer3D(document.getElementById('viewer'));
                viewer.start();
                viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, () => {
                    const ids = viewer.getSelection();
                    const text = ids.length ? `User selected objects with IDs: ${ids.join(', ')}` : 'No objects selected';
                    app.updateModelContext({ content: [{ type: 'text', text }] });
                });
                resolve(viewer);
            });
        });
    }
    return viewerInitializedPromise.then(viewer => {
        Autodesk.Viewing.Document.load(
            'urn:' + urn,
            (doc) => viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry()),
            (errorCode, errorMessage, errors) => console.error('Failed to load document:', errorCode, errorMessage, errors)
        );
    });
}
