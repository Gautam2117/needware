import ApplicationPage from './panel';
export default async function SharedApplication({params}:{params:Promise<{id:string}>}){return <ApplicationPage id={(await params).id}/>;}
